import { expect, test } from "vite-plus/test";
import { detect, type Rule } from "../src/detect.ts";

// Builds a minimal unified diff for one file. `context` lines are unchanged lines shown around the
// edit.
function diff(
  path: string,
  added: string[],
  removed: string[] = [],
  deleted = false,
  context: string[] = [],
): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...(deleted ? ["deleted file mode 100644"] : []),
    `--- a/${path}`,
    `+++ ${deleted ? "/dev/null" : `b/${path}`}`,
    "@@ -1 +1 @@",
    ...context.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
}
const rules = (text: string): Rule[] =>
  detect(text)
    .map((f) => f.rule)
    .sort();

test("a deleted test file is reported once, as a deleted file", () => {
  expect(rules(diff("src/cli.test.ts", [], ['test("x", () => expect(1).toBe(1));'], true))).toEqual(
    ["test-file-deleted"],
  );
});

test("assertions are counted per file: adding some elsewhere does not hide ones removed here", () => {
  const text = [
    diff("src/a.test.ts", [], ["  expect(a).toBe(1);"]),
    diff("src/b.test.ts", ["  expect(b).toBe(1);", "  expect(b).toBe(2);"]),
  ].join("\n");
  expect(
    detect(text)
      .filter((f) => f.rule === "assertions-decreased")
      .map((f) => f.file),
  ).toEqual(["src/a.test.ts"]);
});

test("a conditional skip that states its condition and reason is reported, not blocked", () => {
  const oneLine =
    'test.skip(info.project.name === "desktop", "Desktop answers are covered by inline review tests.");';
  expect(detect(diff("tests/browser/review.e2e.ts", [`  ${oneLine}`]))).toEqual([
    {
      rule: "conditional-skip-added",
      severity: "report",
      file: "tests/browser/review.e2e.ts",
      detail: oneLine,
    },
  ]);
  const multiLine = [
    "  test.skip(",
    '    testInfo.project.name === "desktop",',
    '    "Phone fallback flow; desktop capture is covered separately.",',
    "  );",
  ];
  expect(rules(diff("tests/browser/capture.e2e.ts", multiLine))).toEqual([
    "conditional-skip-added",
  ]);
});

test("a skipped test with a title and body is blocked, even with a condition-like title", () => {
  expect(
    detect(diff("src/a.test.ts", ['test.skip("slow path", () => { expect(1).toBe(1); });']))[0]
      ?.severity,
  ).toBe("block");
  expect(
    detect(diff("src/a.test.ts", ['test.skip("flaky", async ({ page }) => {']))[0]?.severity,
  ).toBe("block");
});

test("focus markers always block, conditional or not", () => {
  expect(detect(diff("src/a.test.ts", ['test.only("focus", () => {});']))[0]?.severity).toBe(
    "block",
  );
  expect(
    detect(diff("src/a.test.ts", ['describe.skipIf(process.env.CI)("suite", () => {']))[0]
      ?.severity,
  ).toBe("block");
});

test("severities: deleted tests, unconditional skips, and a weakened gate block; the rest report", () => {
  const text = [
    diff("src/gone.test.ts", [], ["test('x', () => {});"], true),
    diff(".agent-gate", ["true"], ["bun run check"]),
    diff("src/a.test.ts", ['  expect(out).toBe("new");'], ['  expect(out).toBe("old");']),
  ].join("\n");
  expect(
    detect(text)
      .map((f) => `${f.rule}:${f.severity}`)
      .sort(),
  ).toEqual(["gate-weakened:block", "test-content-changed:report", "test-file-deleted:block"]);
});

test("added skip and focus markers are reported, in every common form", () => {
  for (const marker of [
    "test.skip(",
    "it.only(",
    "describe.skip(",
    "test.todo(",
    "test.fixme(",
    "xit(",
    "xdescribe(",
  ]) {
    expect(rules(diff("src/a.test.ts", [`${marker}"case", () => {});`]))).toEqual([
      "skip-or-focus-added",
    ]);
  }
});

test("a skip marker that was already there and only moved is not reported", () => {
  const line = 'test.skip("slow", () => {});';
  expect(rules(diff("src/a.test.ts", [`  ${line}`], [line]))).toEqual(["test-content-changed"]);
});

test("the word skip in a comment or a file named skip.ts is not a skip marker", () => {
  expect(rules(diff("src/a.test.ts", ["// we skip the network here"]))).toEqual([]);
  expect(rules(diff("src/skip.ts", ['export const skip = "x";']))).toEqual([]);
});

test("removing assertions is reported, and so is the changed test content", () => {
  expect(rules(diff("src/a.test.ts", [], ["  expect(out).toBe(1);"]))).toEqual([
    "assertions-decreased",
    "test-content-changed",
  ]);
});

test("changing an expected value is reported as changed test content, not fewer assertions", () => {
  expect(
    rules(
      diff("src/a.test.ts", ['  expect(out).toBe("R$1,00");'], ['  expect(out).toBe("R$ 1,00");']),
    ),
  ).toEqual(["test-content-changed"]);
});

test("a changed snapshot or expected-output file is reported", () => {
  expect(rules(diff("__tests__/__snapshots__/cli.test.ts.snap", ["new"], ["old"]))).toEqual([
    "test-content-changed",
  ]);
  expect(rules(diff("__tests__/surfaces/expected/page.json", ["{}"], ['{"a":1}']))).toEqual([
    "test-content-changed",
  ]);
});

test("adding a new test, or only adding to an existing test file, is not reported", () => {
  expect(rules(diff("src/new.test.ts", ['test("new", () => expect(1).toBe(1));']))).toEqual([]);
  expect(rules(diff("src/a.test.ts", ['test("more", () => expect(2).toBe(2));']))).toEqual([]);
});

test("a blank-line-only edit in a test file is formatting, not a change", () => {
  expect(rules(diff("src/a.test.ts", ["x"], [""]))).toEqual([]);
});

test("a production-only change is not reported", () => {
  expect(rules(diff("src/cli.ts", ["const a = 2;"], ["const a = 1;"]))).toEqual([]);
});

test("weakening the gate blocks: dropping a command, a workflow gate step, or the agent gate", () => {
  expect(
    rules(
      diff(
        "package.json",
        ['    "check": "biome check && tsc",'],
        ['    "check": "biome check && tsc && bun test",'],
      ),
    ),
  ).toEqual(["gate-weakened"]);
  expect(
    rules(
      diff(
        "package.json",
        ['    "verify": "bun run lint",'],
        ['    "verify": "bun run lint && bun test",'],
      ),
    ),
  ).toEqual(["gate-weakened"]);
  expect(rules(diff(".github/workflows/ci.yml", [], ["      - run: bun run verify"]))).toEqual([
    "gate-weakened",
  ]);
  expect(rules(diff(".agent-gate", ["true"], ["bun run check"]))).toEqual(["gate-weakened"]);
  expect(rules(diff(".agent-gate", [], ["bun run check"], true))).toEqual(["gate-weakened"]);
});

test("strengthening or reshaping the gate only reports", () => {
  expect(
    rules(
      diff(
        "package.json",
        ['    "check": "biome check && tsc && bun test",'],
        ['    "check": "biome check && tsc",'],
      ),
    ),
  ).toEqual([]);
  expect(rules(diff("package.json", ['    "verify": "bun run check && bun test",']))).toEqual([]);
  expect(rules(diff(".agent-gate", ["bun run verify"]))).toEqual([]);
  expect(
    rules(
      diff(".github/workflows/ci.yml", [
        "      - run: bunx playwright install --with-deps chromium",
      ]),
    ),
  ).toEqual(["gate-edited"]);
  expect(
    rules(
      diff(
        ".github/workflows/release.yml",
        [],
        ["          # NPM_TOKEN: ${{ secrets.NPM_TOKEN }}"],
      ),
    ),
  ).toEqual(["gate-edited"]);
  expect(rules(diff("playwright.config.ts", ["  retries: 3,"], ["  retries: 0,"]))).toEqual([
    "gate-edited",
  ]);
});

test("replacing a gate step with an equivalent one that still runs it is not a weakening", () => {
  const moved = diff(
    ".github/workflows/ci.yml",
    ["      - run: bun run verify", "      - run: bun run test:package"],
    ["      - run: bun run verify"],
  );
  expect(rules(moved)).toEqual(["gate-edited"]);
  // `bun test` and `bun run test` run the same step.
  expect(
    rules(
      diff(".github/workflows/ci.yml", ["      - run: bun run test"], ["      - run: bun test"]),
    ),
  ).toEqual(["gate-edited"]);
});

test("folding separate gate steps into one script that runs them all is not a weakening", () => {
  const text = [
    diff(
      ".github/workflows/ci.yml",
      ["      - run: bun run verify"],
      [
        "      - run: bun run format:check",
        "      - run: bun run typecheck",
        "      - run: bun test",
      ],
    ),
    diff("package.json", [
      '    "verify": "bun run format:check && bun run typecheck && bun test",',
    ]),
  ].join("\n");
  expect(rules(text)).toEqual(["gate-edited"]);
});

test("deleting a workflow blocks only when it ran gate steps", () => {
  expect(rules(diff(".github/workflows/ci.yml", [], ["      - run: bun run check"], true))).toEqual(
    ["gate-weakened"],
  );
  expect(
    rules(
      diff(
        ".github/workflows/deploy.yml",
        [],
        ["      - run: bun install --frozen-lockfile", "      - run: wrangler deploy"],
        true,
      ),
    ),
  ).toEqual(["gate-edited"]);
});

test("a step dropped because an unchanged step now runs it is not a weakening", () => {
  const text = [
    diff(".github/workflows/check.yml", [], ["      - run: bun test"], false, [
      "      - run: bun run check",
    ]),
    diff(
      "package.json",
      ['    "check": "biome check && tsc && bun test",'],
      ['    "check": "biome check && tsc",'],
    ),
  ].join("\n");
  expect(rules(text)).toEqual(["gate-edited"]);
});

test("a step dropped with nothing left running it is a weakening, even beside unchanged steps", () => {
  const text = diff(".github/workflows/check.yml", [], ["      - run: bun test"], false, [
    "      - run: bun run check",
  ]);
  expect(detect(text, new Map([["check", "biome check && tsc"]])).map((f) => f.rule)).toEqual([
    "gate-weakened",
  ]);
});

test("folding steps into a script that silently drops one of them is a weakening", () => {
  const text = [
    diff(
      ".github/workflows/ci.yml",
      ["      - run: bun run verify"],
      ["      - run: bun run typecheck", "      - run: bun test"],
    ),
    diff("package.json", ['    "verify": "bun run typecheck",']),
  ].join("\n");
  expect(detect(text).find((f) => f.rule === "gate-weakened")?.detail).toBe(
    "gate step removed: - run: bun test",
  );
});

test("other package.json edits, such as a dependency bump, are not gate changes", () => {
  expect(rules(diff("package.json", ['    "zod": "^4.2.0",'], ['    "zod": "^4.1.0",']))).toEqual(
    [],
  );
});

test("renaming a test file out of the test patterns is reported as removing it from the suite", () => {
  const renamed = [
    "diff --git a/src/a.test.ts b/src/a.ts",
    "similarity index 100%",
    "rename from src/a.test.ts",
    "rename to src/a.ts",
  ].join("\n");
  expect(detect(renamed)).toEqual([
    {
      rule: "test-file-deleted",
      severity: "block",
      file: "src/a.test.ts",
      detail: "test file renamed out of the test suite, to src/a.ts",
    },
  ]);
});

test("renaming a test file to another test path is not a deletion", () => {
  const moved = [
    "diff --git a/src/a.test.ts b/tests/a.test.ts",
    "similarity index 100%",
    "rename from src/a.test.ts",
    "rename to tests/a.test.ts",
  ].join("\n");
  expect(detect(moved)).toEqual([]);
});

test("a diff with a quoted or unusual path is refused rather than misread", () => {
  expect(() => detect('diff --git "a/src/we\\nird.test.ts" "b/src/we\\nird.test.ts"')).toThrow(
    "unsupported file path",
  );
  expect(() => detect("diff --git a/src/has space.test.ts b/src/has space.test.ts")).toThrow(
    "unsupported file path",
  );
});

test("an early return added to a test blocks, in its common forms", () => {
  for (const guard of [
    "if (process.env.CI) return;",
    "if (!ready) { return; }",
    "if (skipSlow) return",
  ]) {
    expect(detect(diff("src/a.test.ts", [`  ${guard}`]))).toEqual([
      { rule: "early-exit-added", severity: "block", file: "src/a.test.ts", detail: guard },
    ]);
  }
});

test("returning a value or an existing early return are not new early exits", () => {
  expect(rules(diff("src/a.test.ts", ["  return result;"]))).toEqual([]);
  // Helpers, mocks, and retry loops return values early; that is ordinary test code.
  expect(rules(diff("src/a.test.ts", ["    if (up) return proc;"]))).toEqual([]);
  expect(
    rules(diff("src/a.test.ts", ["    if (url === TOKEN_URL) return Promise.resolve(token());"])),
  ).toEqual([]);
  expect(rules(diff("src/a.test.ts", ["  if (!context) return 0;"]))).toEqual([]);
  expect(rules(diff("src/a.test.ts", ["  const out = await run();"]))).toEqual([]);
  const moved = "if (process.env.CI) return;";
  expect(rules(diff("src/a.test.ts", [`    ${moved}`], [`  ${moved}`]))).toEqual([
    "test-content-changed",
  ]);
});

test("an early return in production code is not a test weakening", () => {
  expect(rules(diff("src/cli.ts", ["  if (!input) return;"]))).toEqual([]);
});

test("a gate command dropped from a multi-line run block blocks", () => {
  const text = diff(".github/workflows/ci.yml", [], ["          bun test"], false, [
    "      - run: |",
    "          bun run check",
  ]);
  expect(detect(text)).toEqual([
    {
      rule: "gate-weakened",
      severity: "block",
      file: ".github/workflows/ci.yml",
      detail: "gate step removed: bun test",
    },
  ]);
});

test("a multi-line run block that keeps every gate command only reports", () => {
  const text = diff(".github/workflows/ci.yml", ["          echo done"], [], false, [
    "      - run: |",
    "          bun run check",
    "          bun test",
  ]);
  expect(rules(text)).toEqual(["gate-edited"]);
});

test("the shell's `test` builtin and words in an echo are not gate commands", () => {
  const guard = '          test -n "$DB_ID" || { echo "DB_ID is not set"; exit 1; }';
  expect(rules(diff(".github/workflows/deploy.yml", [], [guard]))).toEqual(["gate-edited"]);
  expect(
    rules(diff(".github/workflows/ci.yml", [], ['          echo "run the tests with bun test"'])),
  ).toEqual(["gate-edited"]);
});

test("gate tools invoked through package runners are gate commands", () => {
  for (const command of [
    "bunx biome check src/",
    "npx vitest run",
    "vp check",
    "bun run typecheck",
    "tsc --noEmit",
    "npm test",
  ]) {
    expect(rules(diff(".github/workflows/ci.yml", [], [`      - run: ${command}`]))).toEqual([
      "gate-weakened",
    ]);
  }
});

test("YAML keys and comments in a workflow are not gate commands", () => {
  expect(rules(diff(".github/workflows/ci.yml", [], ["      - name: Run tests"]))).toEqual([
    "gate-edited",
  ]);
  expect(rules(diff(".github/workflows/ci.yml", [], ["        # run the tests again"]))).toEqual([
    "gate-edited",
  ]);
});

test("findings name the file and say what happened", () => {
  const [finding] = detect(diff("src/a.test.ts", ['test.only("focus", () => {});']));
  expect(finding).toEqual({
    rule: "skip-or-focus-added",
    severity: "block",
    file: "src/a.test.ts",
    detail: 'test.only("focus", () => {});',
  });
});
