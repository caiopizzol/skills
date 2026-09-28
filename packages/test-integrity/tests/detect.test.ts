import { expect, test } from "vite-plus/test";
import { detect, type Head, type Rule } from "../src/detect.ts";

// Builds a minimal unified diff for one file.
function diff(path: string, added: string[], removed: string[] = [], deleted = false): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...(deleted ? ["deleted file mode 100644"] : []),
    `--- a/${path}`,
    `+++ ${deleted ? "/dev/null" : `b/${path}`}`,
    "@@ -1 +1 @@",
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
}
const rules = (text: string, head?: Head): Rule[] =>
  detect(text, head)
    .map((f) => f.rule)
    .sort();

// A parsed workflow, as `cli.ts` reads it with Bun.YAML: one pull request job with these steps.
type Step = Record<string, unknown>;
const workflow = (steps: Step[], extra: Record<string, unknown> = {}) => ({
  on: { pull_request: null },
  jobs: { check: { "runs-on": "ubuntu-latest", steps } },
  ...extra,
});
const run = (command: string, more: Step = {}): Step => ({ run: command, ...more });

// A workflow change: a diff that marks the file as edited, and its full contents before and after.
function workflowChange(
  before: unknown,
  after: unknown,
  scripts: Record<string, string> = {},
  path = ".github/workflows/ci.yml",
) {
  const text = diff(path, after === null ? [] : ["# after"], ["# before"], after === null);
  const head: Head = {
    scripts: new Map(Object.entries(scripts)),
    workflows: new Map([[path, { before, after }]]),
  };
  return rules(text, head);
}
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

test("a conditional skip whose reason is a named constant is reported, not blocked", () => {
  // Seen in a real pull request: every case shared one reason constant.
  expect(
    rules(
      diff("tests/browser/surfaces.e2e.ts", [
        '  test.skip(info.project.name !== "desktop", desktopOnly);',
      ]),
    ),
  ).toEqual(["conditional-skip-added"]);
});

test("a skip with no condition, or a literal one, blocks even when a later line has a string call", () => {
  // The call is read by its own arguments, not by text that follows it.
  const later = ['  const origin = baseURL ?? "";', '  expect(out).toBe("x", "y");'];
  for (const call of [
    "test.skip();",
    'test.skip(true, "not now");',
    "test.skip(1, reason);",
    'test.skip("", "why");',
  ]) {
    expect(rules(diff("src/a.test.ts", [`  ${call}`, ...later]))).toEqual(["skip-or-focus-added"]);
  }
});

test("a skip whose call does not close within its lines, or takes three arguments, blocks", () => {
  expect(
    rules(diff("src/a.test.ts", ['  test.skip(browserName === "webkit", "desktop only"'])),
  ).toEqual(["skip-or-focus-added"]);
  expect(
    rules(diff("src/a.test.ts", ['  test.skip(browserName === "webkit", "why", extra);'])),
  ).toEqual(["skip-or-focus-added"]);
});

test("a skip whose condition is always true, or cannot be shown to depend on the run, blocks", () => {
  for (const condition of [
    "!!1",
    "1 === 1",
    "!false",
    "Boolean(1)",
    "ALWAYS",
    "isMobile || true",
    '"a" === "a"',
    'process.platform !== "darwin" || true',
    '(process.platform !== "darwin") || x',
    // Always true: the same value compared both ways, or against two values, joined by "or".
    'info.project.name === "desktop" || info.project.name !== "desktop"',
    'info.project.name !== "desktop" || info.project.name !== "iphone"',
    'process.platform === "darwin" || process.platform !== "darwin"',
    'info.project.name !== "desktop" || testInfo.project.name !== "iphone"',
    // Mixed "and" and "or" is not read.
    'process.platform !== "darwin" && info.project.name !== "a" || browserName === "b"',
  ]) {
    expect(rules(diff("src/a.test.ts", [`  test.skip(${condition}, "why");`]))).toEqual([
      "skip-or-focus-added",
    ]);
  }
});

test("conditions that compare the run to a string are conditional skips", () => {
  for (const condition of [
    'info.project.name !== "desktop"',
    'testInfo.project.name === "desktop"',
    'process.platform !== "darwin"',
    'browserName === "webkit"',
    'process.env.CI === "true"',
    // Seen in a real pull request: two run comparisons joined.
    'info.project.name !== "iphone" || process.platform !== "darwin"',
    // "And" over the same value can be never true, which only skips less.
    'info.project.name !== "desktop" && info.project.name !== "iphone"',
  ]) {
    expect(rules(diff("src/a.test.ts", [`  test.skip(${condition}, "why");`]))).toEqual([
      "conditional-skip-added",
    ]);
  }
});

test("escaped quotes stay inside their string, so they cannot hide or split an argument", () => {
  // A reason with an escaped quote is still one argument.
  for (const reason of [String.raw`'It doesn\'t matter'`, String.raw`"He said \"no\""`]) {
    expect(
      rules(diff("src/a.test.ts", [`  test.skip(browserName === "webkit", ${reason});`])),
    ).toEqual(["conditional-skip-added"]);
  }
  expect(
    rules(diff("src/a.test.ts", [String.raw`  test.skip(browserName === "a\"b", "why");`])),
  ).toEqual(["conditional-skip-added"]);
  // An escaped quote cannot end a string early and hide an always-true condition after it.
  expect(
    rules(diff("src/a.test.ts", [String.raw`  test.skip(browserName === "\")" || true, "why");`])),
  ).toEqual(["skip-or-focus-added"]);
});

test("operators inside a compared string are part of the string", () => {
  for (const text of ['"a || b"', '"a && b"', '"a === b"']) {
    expect(
      rules(diff("src/a.test.ts", [`  test.skip(process.env.MODE === ${text}, "why");`])),
    ).toEqual(["conditional-skip-added"]);
  }
});

test("under or, one value may repeat only as equality with different strings", () => {
  expect(
    rules(
      diff("src/a.test.ts", [
        '  test.skip(browserName === "chromium" || browserName === "firefox", "why");',
      ]),
    ),
  ).toEqual(["conditional-skip-added"]);
  for (const condition of [
    'browserName === "chromium" || browserName === "chromium"',
    'browserName === "chromium" || browserName !== "firefox"',
  ]) {
    expect(rules(diff("src/a.test.ts", [`  test.skip(${condition}, "why");`]))).toEqual([
      "skip-or-focus-added",
    ]);
  }
});

test("a condition and a function body is a skipped test, not a conditional skip", () => {
  for (const call of [
    'test.skip(browserName === "webkit", () => {});',
    'test.skip(browserName === "webkit", function () {});',
  ]) {
    expect(rules(diff("src/a.test.ts", [`  ${call}`]))).toEqual(["skip-or-focus-added"]);
  }
});

test("commas and parentheses inside a reason string do not change the skip's arguments", () => {
  for (const reason of ['"phones, tablets"', '"open ( only"', "'close ) early'"]) {
    expect(
      rules(diff("src/a.test.ts", [`  test.skip(browserName === "webkit", ${reason});`])),
    ).toEqual(["conditional-skip-added"]);
  }
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

test("weakening the gate blocks: dropping a command, a workflow gate command, or the agent gate", () => {
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
  expect(workflowChange(workflow([run("bun run verify")]), workflow([]))).toEqual([
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
    workflowChange(
      workflow([run("bun run check")]),
      workflow([run("bunx playwright install --with-deps chromium"), run("bun run check")]),
    ),
  ).toEqual(["gate-edited"]);
  expect(rules(diff("playwright.config.ts", ["  retries: 3,"], ["  retries: 0,"]))).toEqual([
    "gate-edited",
  ]);
});

test("a workflow change must come with the workflow's contents, or the check refuses it", () => {
  expect(() => rules(diff(".github/workflows/ci.yml", ["# after"], ["# before"]))).toThrow(
    "were not supplied",
  );
});

test("replacing a gate command with one that runs the same script is not a weakening", () => {
  // `npm test`, `pnpm test`, `yarn test`, and `bun run test` all run the `test` script.
  for (const command of ["npm test", "pnpm test", "yarn test", "pnpm run test"]) {
    expect(workflowChange(workflow([run("bun run test")]), workflow([run(command)]))).toEqual([
      "gate-edited",
    ]);
  }
});

test("`bun test` is the test runner, not the `test` script, so one does not cover the other", () => {
  // A root `test` script can run more than the runner, such as each workspace's tests.
  const scripts = { test: "bun scripts/run-workspaces.ts test && bun test scripts/" };
  expect(
    workflowChange(workflow([run("bun run test")]), workflow([run("bun test")]), scripts),
  ).toEqual(["gate-weakened"]);
});

test("folding separate gate commands into one root script that runs them all is not a weakening", () => {
  const before = workflow([run("bun run format:check"), run("bun run typecheck"), run("bun test")]);
  const verify = "bun run format:check && bun run typecheck && bun test";
  expect(workflowChange(before, workflow([run("bun run verify")]), { verify })).toEqual([
    "gate-edited",
  ]);
  // The same fold into a script that silently drops one of them is a weakening.
  expect(
    workflowChange(before, workflow([run("bun run verify")]), {
      verify: "bun run format:check && bun run typecheck",
    }),
  ).toEqual(["gate-weakened"]);
});

test("deleting a workflow blocks only when it ran gate commands", () => {
  expect(workflowChange(workflow([run("bun run check")]), null)).toEqual(["gate-weakened"]);
  expect(
    workflowChange(
      workflow([run("bun install --frozen-lockfile"), run("wrangler deploy")]),
      null,
      {},
      ".github/workflows/deploy.yml",
    ),
  ).toEqual(["gate-edited"]);
});

test("a command dropped because an unchanged step's script now runs it is not a weakening", () => {
  const before = workflow([run("bun run check"), run("bun test")]);
  const after = workflow([run("bun run check")]);
  expect(workflowChange(before, after, { check: "biome check && tsc && bun test" })).toEqual([
    "gate-edited",
  ]);
  expect(workflowChange(before, after, { check: "biome check && tsc" })).toEqual(["gate-weakened"]);
});

test("a gate command dropped from a multi-line run block blocks; one kept only reports", () => {
  const before = workflow([run("bun run check\nbun test\n")]);
  expect(workflowChange(before, workflow([run("bun run check\n")]))).toEqual(["gate-weakened"]);
  expect(workflowChange(before, workflow([run("bun run check\nbun test\necho done\n")]))).toEqual([
    "gate-edited",
  ]);
});

test("the shell's `test` builtin, words in an echo, and comments are not gate commands", () => {
  const guard = 'test -n "$DB_ID" || { echo "DB_ID is not set"; exit 1; }';
  for (const command of [guard, 'echo "run the tests with bun test"', "# bun test"]) {
    expect(workflowChange(workflow([run(command)]), workflow([]))).toEqual(["gate-edited"]);
  }
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
    expect(workflowChange(workflow([run(command)]), workflow([]))).toEqual(["gate-weakened"]);
  }
});

test("a gate command inside a shell conditional or behind an environment variable is a gate command", () => {
  for (const command of [
    'if [ -n "$CI" ]; then bun test; fi',
    "for dir in a b; do bun run check; done",
    "CI=1 bun test",
  ]) {
    expect(workflowChange(workflow([run(command)]), workflow([]))).toEqual(["gate-weakened"]);
  }
});

test("a command is covered only when every gate command of the removed step still runs", () => {
  const scripts = { check: "vp check && bun test" };
  expect(
    workflowChange(workflow([run("bun run check")]), workflow([run("vp check")]), scripts),
  ).toEqual(["gate-weakened"]);
  expect(
    workflowChange(
      workflow([run("bun run check")]),
      workflow([run("vp check"), run("bun test")]),
      scripts,
    ),
  ).toEqual(["gate-edited"]);
  expect(
    workflowChange(workflow([run("vp check && bun test")]), workflow([run("vp check")])),
  ).toEqual(["gate-weakened"]);
});

test("a step's working directory scopes its commands: another directory never covers it", () => {
  const scripts = { test: "bun test", check: "bun run test" };
  const inApi = { "working-directory": "packages/api" };
  // Moved from packages/api to the root: the root's `test` script is not the package's.
  expect(
    workflowChange(
      workflow([run("bun run test", inApi)]),
      workflow([run("bun run test")]),
      scripts,
    ),
  ).toEqual(["gate-weakened"]);
  // Replaced in packages/api by a script that, at the root, would run it.
  expect(
    workflowChange(
      workflow([run("bun run test", inApi)]),
      workflow([run("bun run check", inApi)]),
      scripts,
    ),
  ).toEqual(["gate-weakened"]);
  // A job-level default directory scopes its steps too.
  const jobDefault = {
    jobs: {
      check: {
        defaults: { run: { "working-directory": "packages/api" } },
        steps: [run("bun test")],
      },
    },
  };
  expect(workflowChange(workflow([], jobDefault), workflow([run("bun test")]), scripts)).toEqual([
    "gate-weakened",
  ]);
});

test("a working directory elsewhere in the workflow does not block an unrelated covered change", () => {
  const other = run("bun install --frozen-lockfile", { "working-directory": "packages/web" });
  const before = workflow([other, run("bun test"), run("bun run check")]);
  const after = workflow([run("bun run check")]);
  expect(workflowChange(before, after, { check: "biome check && bun test" })).toEqual([
    "gate-edited",
  ]);
});

test("a command still run only by a push-only workflow, another job, or a skipped step is dropped", () => {
  const before = workflow([run("bun test")]);
  const onPushOnly = { ...workflow([run("bun test")]), on: { push: { branches: ["main"] } } };
  expect(workflowChange(before, onPushOnly)).toEqual(["gate-weakened"]);
  const otherJob = { on: { pull_request: null }, jobs: { release: { steps: [run("bun test")] } } };
  expect(workflowChange(before, otherJob)).toEqual(["gate-weakened"]);
  expect(workflowChange(before, workflow([run("bun test", { if: "false" })]))).toEqual([
    "gate-weakened",
  ]);
  expect(
    workflowChange(before, workflow([run("bun test", { "continue-on-error": true })])),
  ).toEqual(["gate-weakened"]);
  const skippedJob = {
    on: { pull_request: null },
    jobs: { check: { if: "github.event_name == 'push'", steps: [run("bun test")] } },
  };
  expect(workflowChange(before, skippedJob)).toEqual(["gate-weakened"]);
});

test("pull request triggers are read in every YAML form", () => {
  for (const on of ["pull_request", ["push", "pull_request"], { pull_request_target: null }]) {
    const before = { ...workflow([run("bun test")]), on };
    const after = { ...workflow([run("bun test"), run("echo done")]), on };
    expect(workflowChange(before, after)).toEqual(["gate-edited"]);
  }
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

test("findings name the file and say what happened", () => {
  const [finding] = detect(diff("src/a.test.ts", ['test.only("focus", () => {});']));
  expect(finding).toEqual({
    rule: "skip-or-focus-added",
    severity: "block",
    file: "src/a.test.ts",
    detail: 'test.only("focus", () => {});',
  });
});

test("an early return spread over three lines blocks like the one-line form", () => {
  expect(detect(diff("src/a.test.ts", ["  if (process.env.CI) {", "    return;", "  }"]))).toEqual([
    {
      rule: "early-exit-added",
      severity: "block",
      file: "src/a.test.ts",
      detail: "if (process.env.CI) { return; }",
    },
  ]);
  // A guard with more in its body, or one that returns a value, is ordinary test code.
  expect(rules(diff("src/a.test.ts", ["  if (!up) {", "    await start();", "  }"]))).toEqual([]);
  expect(rules(diff("src/a.test.ts", ["  if (cached) {", "    return cached;", "  }"]))).toEqual(
    [],
  );
});

test("narrowing a pull request trigger's filters counts as no longer running its commands", () => {
  const before = workflow([run("bun test")]);
  for (const trigger of [
    { pull_request: { types: ["closed"] } },
    { pull_request: { branches: ["release"] } },
    { pull_request: { paths: ["docs/**"] } },
  ]) {
    expect(workflowChange(before, { ...workflow([run("bun test")]), on: trigger })).toEqual([
      "gate-weakened",
    ]);
  }
});

test("a condition that is not a short scalar never counts as still running a command", () => {
  // A YAML alias graph can make a tiny file serialize to megabytes; such a value is not compared.
  let graph: unknown = ["x", "x", "x", "x", "x", "x", "x", "x", "x", "x"];
  for (let level = 0; level < 6; level++) graph = Array.from({ length: 10 }, () => graph);
  const guarded = (condition: unknown) => workflow([run("bun test", { if: condition })]);
  expect(workflowChange(guarded(graph), guarded(graph))).toEqual(["gate-weakened"]);
  expect(
    workflowChange(guarded("github.actor != 'bot'"), guarded("github.actor != 'bot'")),
  ).toEqual(["gate-edited"]);
});

test("a workflow that runs too much text to read is refused", () => {
  const long = run(`bun test\n${"echo x\n".repeat(200_000)}`);
  expect(() => workflowChange(workflow([long]), workflow([]))).toThrow("too much text");
});

test("widening a pull request trigger, by removing a filter, still runs its commands", () => {
  const narrow = { ...workflow([run("bun test")]), on: { pull_request: { branches: ["main"] } } };
  const wide = { ...workflow([run("bun test")]), on: { push: null, pull_request: null } };
  expect(workflowChange(narrow, wide)).toEqual(["gate-edited"]);
  // Adding a filter narrows it.
  expect(workflowChange(wide, narrow)).toEqual(["gate-weakened"]);
});

test("a gate command that a changed run block can skip or ignore no longer counts", () => {
  const before = workflow([run("bun test")]);
  for (const block of [
    "if false; then\n  bun test\nfi\n",
    "bun test || true\n",
    "set +e\nbun test\n",
    "exit 0\nbun test\n",
    "trap 'exit 0' ERR\nbun test\n",
    "bun test &\n",
    "bun test && echo passed\necho done\n",
    "bun test ${{ '|| true' }}\n",
  ]) {
    expect(workflowChange(before, workflow([run(block)]))).toEqual(["gate-weakened"]);
  }
  // A line before the command that could stop the step or turn off its error handling.
  for (const setup of [
    "${{ inputs.setup }}",
    "$SETUP",
    "exec true",
    "CI=1 exit 0",
    "'exit' 0",
    'echo "$(exit 0)"',
    "cd packages/api",
    "pushd packages/api",
    "export BUN_TEST_FILTER=none",
  ]) {
    expect(workflowChange(before, workflow([run(`${setup}\nbun test\n`)]))).toEqual([
      "gate-weakened",
    ]);
  }
  // A shell that does not stop on errors changes the step's scope.
  expect(
    workflowChange(before, workflow([run("bun test\necho done\n", { shell: "bash {0}" })])),
  ).toEqual(["gate-weakened"]);
});

test("a changed run block whose failures stop the step still counts", () => {
  const before = workflow([run("bun test")]);
  // Commands compare as written: `bun test 2>&1` or `bun test src/a` is not `bun test`.
  for (const block of [
    "bun install\nbun test\n",
    "bun run build && bun test\n",
    "bun test\necho done > summary.txt\n",
    // On the last command line, a failure left of `&&` still fails the step: under
    // `bash --noprofile --norc -eo pipefail`, `false && echo passed` exits 1.
    "bun test && echo passed\n",
    "bun test && echo passed\n# done\n",
  ]) {
    expect(workflowChange(before, workflow([run(block)]))).toEqual(["gate-edited"]);
  }
});

test("an unchanged step keeps counting, even with shell control flow", () => {
  const guarded = run('if [ -n "$CI" ]; then bun test; fi');
  expect(
    workflowChange(workflow([guarded, run("echo a")]), workflow([guarded, run("echo b")])),
  ).toEqual(["gate-edited"]);
});

test("a changed run block counts only in a shell that stops on the first failure", () => {
  const block = "bun test\necho done\n";
  // `bash {0}` runs without `-e`, so a failing `bun test` is followed by `echo done`, which exits 0.
  const noErrexit = { shell: "bash {0}" };
  expect(
    workflowChange(workflow([run("bun test", noErrexit)]), workflow([run(block, noErrexit)])),
  ).toEqual(["gate-weakened"]);
  // Windows runners default to PowerShell, and a runner chosen by an expression is unknown.
  // A self-hosted runner may be Windows too, so only GitHub-hosted Linux and macOS labels count.
  for (const runsOn of [
    "windows-latest",
    "${{ matrix.os }}",
    "self-hosted",
    ["self-hosted", "linux"],
  ]) {
    const on = (script: string) => ({
      on: { pull_request: null },
      jobs: { check: { "runs-on": runsOn, steps: [run(script)] } },
    });
    expect(workflowChange(on("bun test"), on(block))).toEqual(["gate-weakened"]);
  }
  for (const runsOn of ["ubuntu-24.04", "macos-15", "ubuntu-24.04-arm"]) {
    const on = (script: string) => ({
      on: { pull_request: null },
      jobs: { check: { "runs-on": runsOn, steps: [run(script)] } },
    });
    expect(workflowChange(on("bun test"), on(block))).toEqual(["gate-edited"]);
  }
  // `bash` and `sh` stop on errors, like the default on Linux.
  for (const shell of ["bash", "sh"]) {
    expect(
      workflowChange(workflow([run("bun test", { shell })]), workflow([run(block, { shell })])),
    ).toEqual(["gate-edited"]);
  }
  // An unchanged block moved to a Windows runner no longer runs the same way.
  const moved = {
    on: { pull_request: null },
    jobs: { check: { "runs-on": "windows-latest", steps: [run(block)] } },
  };
  expect(workflowChange(workflow([run(block)]), moved)).toEqual(["gate-weakened"]);
});

test("pytest's test files and shared fixtures are test files, and deleting one blocks", () => {
  for (const path of ["tests/test_main.py", "apps/api/test_sql_guard.py", "pkg/cli_test.py"]) {
    expect(rules(diff(path, [], ["def test_a():", "    assert 1"], true))).toEqual([
      "test-file-deleted",
    ]);
  }
  expect(rules(diff("tests/conftest.py", [], ["@pytest.fixture"], true))).toEqual([
    "test-file-deleted",
  ]);
  // Production modules and a test data helper outside test paths are not test files.
  expect(rules(diff("processor.py", [], ["def run():"], true))).toEqual([]);
  expect(rules(diff("scripts/testing.py", [], ["x = 1"], true))).toEqual([]);
});

test("an unconditional pytest or unittest skip or expected failure blocks, in every common form", () => {
  for (const marker of [
    "@pytest.mark.skip",
    '@pytest.mark.skip(reason="flaky")',
    "@pytest.mark.xfail",
    "@mark.skip",
    '@unittest.skip("later")',
    "@unittest.expectedFailure",
    '@skip("later")',
    "pytestmark = pytest.mark.skip",
    "    pytest.param(3, marks=pytest.mark.xfail),",
    '    pytest.skip("not ready")',
    '    pytest.xfail("known")',
    '    pytest.importorskip("sentry_sdk")',
    '        self.skipTest("later")',
    '    raise unittest.SkipTest("later")',
    "__test__ = False",
    "    __test__ = False",
  ]) {
    expect(rules(diff("tests/test_a.py", [marker]))).toEqual(["skip-or-focus-added"]);
  }
});

test("collect_ignore stops collection only in a conftest, so only there is it a skip", () => {
  for (const line of ['collect_ignore = ["test_slow.py"]', 'collect_ignore_glob.append("it/*")']) {
    expect(rules(diff("tests/conftest.py", [line]))).toEqual(["skip-or-focus-added"]);
    expect(rules(diff("tests/test_a.py", [line]))).toEqual([]);
  }
  expect(rules(diff("tests/conftest.py", ["# collect_ignore used to list slow files"]))).toEqual(
    [],
  );
});

test("a skip that always holds, or that cannot be shown to depend on the run, blocks", () => {
  for (const marker of [
    '@pytest.mark.skipif(True, reason="later")',
    '@pytest.mark.skipif(1 == 1, reason="later")',
    '@pytest.mark.skipif("sys.platform", reason="later")',
    '@pytest.mark.skipif(SLOW, reason="later")',
    '@pytest.mark.skipif(not IMAGE, reason="later")',
    '@pytest.mark.skipif(os.name != "posix")',
    '@pytest.mark.skipif(os.name == "nt" or os.name != "nt", reason="always")',
    '@unittest.skipUnless(_DEPS, "needs the image")',
    // `skipUnless` skips when its condition is false, and this one never holds.
    '@unittest.skipUnless(sys.platform == "win32" and sys.platform == "linux", "never")',
    '@pytest.mark.skipif(os.name != "posix", reason=explain())',
    '@pytest.mark.skipif(os.name != "posix", reason=f"needs {SIGNAL}")',
    '@pytest.mark.skipif(condition=True, reason="later")',
    '@pytest.mark.skipif(reason="x", reason="y")',
    '@pytest.mark.skipif(condition=os.name != "posix", "x")',
  ]) {
    expect(rules(diff("tests/test_a.py", [marker]))).toEqual(["skip-or-focus-added"]);
  }
});

test("a skip conditioned on the platform or the environment is reported, not blocked", () => {
  for (const marker of [
    '@pytest.mark.skipif(os.name != "posix", reason="Requires SIGKILL")',
    "@pytest.mark.skipif(sys.platform == 'win32', reason='no fork')",
    '@pytest.mark.skipif(platform.system() == "Darwin", "not on macOS")',
    '@pytest.mark.skipif(os.environ.get("CI") == "true", reason=NEEDS_NETWORK)',
    '@pytest.mark.skipif(os.getenv("DB") != "postgres", reason="postgres only")',
    '@unittest.skipIf(sys.platform == "win32", "no fork")',
    '@unittest.skipUnless(sys.platform == "linux", "needs Linux")',
    '@unittest.skipUnless(sys.platform == "linux" or sys.platform == "darwin", "needs Unix")',
    '@pytest.mark.xfail(sys.platform == "darwin", reason="known on macOS")',
    '@pytest.mark.skipif(sys.platform == "win32" or sys.platform == "cygwin", reason="no fork")',
    '@pytest.mark.skipif(condition=os.name != "posix", reason="Requires SIGKILL")',
    '@pytest.mark.skipif(reason="Requires SIGKILL", condition=os.name != "posix")',
  ]) {
    expect(rules(diff("tests/test_a.py", [marker]))).toEqual(["conditional-skip-added"]);
  }
  // The same skip spread over lines, with adjacent strings as the reason.
  expect(
    rules(
      diff("tests/test_a.py", [
        "@pytest.mark.skipif(",
        '    os.name != "posix",',
        '    reason="Requires SIGKILL "',
        '    "to stop the database",',
        ")",
      ]),
    ),
  ).toEqual(["conditional-skip-added"]);
});

test("a conditional marker beside an unconditional one on the same line blocks", () => {
  expect(
    rules(
      diff("tests/test_a.py", [
        '    pytest.param(1, marks=[pytest.mark.skipif(os.name != "posix", reason="x"), pytest.mark.skip]),',
      ]),
    ),
  ).toEqual(["skip-or-focus-added"]);
});

test("a skip in a comment, a moved skip, or a Python file outside the tests is not a skip", () => {
  expect(rules(diff("tests/test_a.py", ["# pytest.mark.skip once flaked here"]))).toEqual([]);
  expect(rules(diff("tests/test_a.py", ["__test__ = True"]))).toEqual([]);
  const moved = '@pytest.mark.skipif(not IMAGE, reason="x")';
  expect(rules(diff("tests/test_a.py", [`${moved}`], [`${moved}  `]))).toEqual([
    "test-content-changed",
  ]);
  expect(rules(diff("processor.py", ["    pytest.skip()"]))).toEqual([]);
});

test("an added bare return in a Python test blocks", () => {
  expect(detect(diff("tests/test_a.py", ["    if not ready:", "        return"]))).toEqual([
    { rule: "early-exit-added", severity: "block", file: "tests/test_a.py", detail: "return" },
  ]);
  expect(rules(diff("tests/test_a.py", ["    if os.environ.get('CI'): return"]))).toEqual([
    "early-exit-added",
  ]);
  expect(rules(diff("tests/test_a.py", ["    return  # not ready"]))).toEqual(["early-exit-added"]);
  for (const line of ["    return;", "    return None;", "    if skip: return;  # later"]) {
    expect(rules(diff("tests/test_a.py", [line]))).toEqual(["early-exit-added"]);
  }
  // `return None` is a bare return, even where a helper uses it as an answer.
  expect(rules(diff("tests/test_a.py", ["    return None"]))).toEqual(["early-exit-added"]);
});

test("returning a value, an existing return, or a return in production code is not an early exit", () => {
  expect(rules(diff("tests/conftest.py", ["    return Database(url)"]))).toEqual([]);
  expect(rules(diff("tests/test_a.py", ["        return False"]))).toEqual([]);
  expect(rules(diff("tests/test_a.py", ["    if cached: return cached"]))).toEqual([]);
  expect(rules(diff("tests/test_a.py", ["        return", "    "], ["    return"]))).toEqual([
    "test-content-changed",
  ]);
  expect(rules(diff("processor.py", ["    return"]))).toEqual([]);
});

test("removing Python assertions is reported, counted per statement or call", () => {
  expect(
    rules(diff("tests/test_a.py", [], ["    assert out == 1", "    self.assertEqual(a, b)"])),
  ).toEqual(["assertions-decreased", "test-content-changed"]);
  for (const assertion of [
    "    with pytest.raises(ValueError):",
    "    with pytest.warns(UserWarning):",
    "    db.close.assert_called_once()",
    "    mock_download.assert_not_called()",
  ]) {
    expect(rules(diff("tests/test_a.py", [], [assertion]))).toEqual([
      "assertions-decreased",
      "test-content-changed",
    ]);
  }
  // A changed expected value is changed content, not fewer assertions.
  expect(rules(diff("tests/test_a.py", ["    assert out == 2"], ["    assert out == 1"]))).toEqual([
    "test-content-changed",
  ]);
  // A variable named like an assertion is not one.
  expect(rules(diff("tests/test_a.py", [], ["    assertion_count = 3"]))).toEqual([
    "test-content-changed",
  ]);
});

// A task runner file change: a diff that marks the file as edited, and its text before and after.
function taskChange(before: string | null, after: string | null, path = "justfile") {
  const text = diff(path, after === null ? [] : ["# after"], ["# before"], after === null);
  return rules(text, { taskFiles: new Map([[path, { before, after }]]) });
}
const recipes = (check: string, extra = "") =>
  `# tasks\ninstall:\n    uv sync\n\ntest:\n    uv run --frozen pytest --cov\n\ncheck:\n    ${check}\n${extra}`;
const FULL_CHECK =
  "uv run --frozen ruff check . && uv run --frozen ruff format --check . && uv run --frozen pyright && uv run --frozen pytest --cov";

test("Python gate tools, run directly or through uv, python -m, poetry, just, or make, are gate commands", () => {
  for (const command of [
    "uv run --frozen pytest --cov --cov-report=xml",
    "uv run --frozen ruff check .",
    "uv run --frozen pyright",
    "uv run --with pytest-cov pytest",
    "python -m pytest -q",
    "uv run python -m pytest",
    "poetry run pytest",
    "TEST_IMAGE=app:ci uv run --frozen pytest tests/test_recovery.py",
    "pytest",
    "mypy src",
    "just check",
    "make test",
  ]) {
    expect(workflowChange(workflow([run(command)]), workflow([]))).toEqual(["gate-weakened"]);
  }
  for (const command of ["uv sync", "uv run python main.py --list", "just run", "make build"]) {
    expect(workflowChange(workflow([run(command)]), workflow([]))).toEqual(["gate-edited"]);
  }
});

test("dropping a command from a gate recipe, or the recipe itself, blocks", () => {
  expect(
    taskChange(
      recipes(FULL_CHECK),
      recipes("uv run --frozen ruff check . && uv run --frozen pyright"),
    ),
  ).toEqual(["gate-weakened"]);
  // Dropping a flag changes the command, as for a package script.
  expect(
    taskChange(recipes(FULL_CHECK), recipes(FULL_CHECK.replace("pytest --cov", "pytest"))),
  ).toEqual(["gate-weakened"]);
  expect(taskChange(recipes(FULL_CHECK), "install:\n    uv sync\n")).toEqual([
    "gate-weakened",
    "gate-weakened",
  ]);
  expect(taskChange(recipes(FULL_CHECK), null)).toEqual(["gate-weakened", "gate-weakened"]);
  const make = (test: string) => `.PHONY: test\ntest:\n\t${test}\n`;
  expect(taskChange(make("pytest -q && ruff check ."), make("ruff check ."), "Makefile")).toEqual([
    "gate-weakened",
  ]);
});

test("adding to a gate recipe, reshaping it through dependencies, or editing other recipes only reports", () => {
  expect(taskChange(recipes(FULL_CHECK), recipes(`${FULL_CHECK} && uv run mypy .`))).toEqual([
    "gate-edited",
  ]);
  // A check that now depends on recipes running the same commands still runs them all.
  const split =
    "# tasks\nlint:\n    uv run --frozen ruff check .\n    uv run --frozen ruff format --check .\n\n" +
    "typecheck:\n    uv run --frozen pyright\n\ntest:\n    uv run --frozen pytest --cov\n\n" +
    "check: lint typecheck test\n";
  expect(taskChange(recipes(FULL_CHECK), split)).toEqual(["gate-edited"]);
  expect(
    taskChange(
      recipes(FULL_CHECK, "\nrun *ARGS:\n    uv run python main.py {{ARGS}}\n"),
      recipes(FULL_CHECK),
    ),
  ).toEqual(["gate-edited"]);
  // A command continued over lines reads as one command.
  expect(
    taskChange(
      recipes("uv run --frozen pytest --cov"),
      recipes("uv run --frozen \\\n        pytest --cov"),
    ),
  ).toEqual(["gate-edited"]);
});

test("a gate recipe that depends on one the file no longer defines, or on a cycle, still counts what it ran", () => {
  expect(taskChange("check: lint\nlint:\n    ruff check .\n", "check: lint\n")).toEqual([
    "gate-weakened",
  ]);
  expect(taskChange("check: a\na: check\n    pytest\n", "check: a\na: check\n")).toEqual([
    "gate-weakened",
  ]);
});

test("a task runner change must come with the file's contents, or the check refuses it", () => {
  expect(() => rules(diff("justfile", ["# after"], ["# before"]))).toThrow("were not supplied");
});

// A `pyproject.toml` change, with the file parsed before and after.
function pyprojectChange(before: unknown, after: unknown) {
  const text = diff("pyproject.toml", ["# after"], ["# before"]);
  return rules(text, { pyprojects: new Map([["pyproject.toml", { before, after }]]) });
}
const pyproject = (pytest: Record<string, unknown>, version = "1.0.0") => ({
  project: { name: "pipeline", version },
  tool: { pytest: { ini_options: pytest }, ruff: { "line-length": 120 } },
});

test("pytest settings that narrow the run, or a lower coverage minimum, block", () => {
  const base = { testpaths: ["tests"], addopts: "-v --tb=short" };
  const coverage = (fail_under: unknown) => ({
    ...pyproject(base),
    tool: { ...pyproject(base).tool, coverage: { report: { fail_under } } },
  });
  for (const after of [
    pyproject({ ...base, addopts: "-v --tb=short -k 'not slow'" }),
    pyproject({ ...base, addopts: "-v --tb=short --deselect tests/test_main.py::test_run" }),
    pyproject({ ...base, addopts: "-v --tb=short -p no:randomly" }),
    pyproject({ ...base, addopts: "-v --tb=short tests/unit" }),
    pyproject({ ...base, testpaths: ["tests/unit"] }),
    pyproject({ ...base, python_files: "test_fast_*.py" }),
  ]) {
    expect(pyprojectChange(pyproject(base), after)).toEqual(["gate-weakened"]);
  }
  // Dropping an option that is not a report option, such as `--strict-markers`, blocks too.
  expect(
    pyprojectChange(pyproject({ ...base, addopts: "-v --strict-markers" }), pyproject(base)),
  ).toEqual(["gate-weakened"]);
  // A native `[tool.pytest]` table is read like `[tool.pytest.ini_options]`.
  expect(
    pyprojectChange(pyproject(base), {
      ...pyproject(base),
      tool: { pytest: { ini_options: base, addopts: "-v --tb=short -k fast" } },
    }),
  ).toEqual(["gate-weakened"]);
  for (const after of [coverage(50), coverage("fifty"), pyproject(base)]) {
    expect(pyprojectChange(coverage(94), after)).toEqual(["gate-weakened"]);
  }
  expect(pyprojectChange(pyproject(base), null)).toEqual(["gate-weakened"]);
});

test("pytest settings that keep or widen the run, or a higher coverage minimum, only report", () => {
  const base = { testpaths: ["tests"], addopts: "-v --tb=short" };
  const coverage = (fail_under: number) => ({
    ...pyproject(base),
    tool: { ...pyproject(base).tool, coverage: { report: { fail_under, precision: 2 } } },
  });
  for (const after of [
    pyproject({ ...base, addopts: "-q --tb=long" }),
    pyproject({ ...base, addopts: "-v --tb=short --cov" }),
    pyproject({ ...base, markers: ["slow: runs for minutes"] }),
    // Dropping only report options leaves the same tests running.
    pyproject({ testpaths: ["tests"] }),
  ]) {
    expect(pyprojectChange(pyproject(base), after)).toEqual(["gate-edited"]);
  }
  // A project configuring pytest for the first time reports, unless it chooses which tests run.
  const first = { project: { name: "pipeline" } };
  expect(pyprojectChange(first, pyproject({ addopts: "-v" }))).toEqual(["gate-edited"]);
  for (const setting of [
    { testpaths: ["unit"] },
    { python_files: "test_*.py" },
    { norecursedirs: ["slow"] },
  ]) {
    expect(pyprojectChange(first, pyproject(setting))).toEqual(["gate-weakened"]);
  }
  expect(pyprojectChange(pyproject(base), coverage(94))).toEqual(["gate-edited"]);
  expect(pyprojectChange(coverage(90), coverage(94))).toEqual(["gate-edited"]);
});

test("a release version bump or another tool's settings in pyproject.toml is not a gate change", () => {
  const base = { testpaths: ["tests"] };
  expect(pyprojectChange(pyproject(base, "1.0.0"), pyproject(base, "1.0.1"))).toEqual([]);
  expect(
    pyprojectChange(pyproject(base), {
      ...pyproject(base),
      tool: { ...pyproject(base).tool, ruff: { "line-length": 100 } },
    }),
  ).toEqual([]);
});

test("pytest's own configuration files are test runner configuration", () => {
  for (const path of ["pytest.ini", "tox.ini", "setup.cfg", ".coveragerc"]) {
    expect(rules(diff(path, ["addopts = -x"], ["addopts = -v"]))).toEqual(["gate-edited"]);
  }
});

test("uv's environment flags and pytest's report options do not change which tests a command runs", () => {
  for (const [before, after] of [
    ["uv run ruff check .", "uv run --frozen ruff check ."],
    ["uv run pytest", "uv run --frozen --locked pytest"],
    ["uv run pytest", "uv run pytest --cov --cov-branch --cov-report=xml"],
    [
      "uv run --frozen pytest --cov --cov-branch --cov-report=xml",
      "uv run --frozen pytest --cov --cov-report=xml --cov-report=term-missing",
    ],
    ["pytest -v --tb=short", "pytest -q"],
    ["uv run pytest --cov", "uv run pytest --cov --cov-fail-under=94"],
  ]) {
    expect(workflowChange(workflow([run(before)]), workflow([run(after)]))).toEqual([
      "gate-edited",
    ]);
    expect(taskChange(recipes(before), recipes(after))).toEqual(["gate-edited"]);
  }
});

test("a pytest command that narrows the run, drops coverage, or turns into another tool still blocks", () => {
  for (const [before, after] of [
    ["uv run pytest", "uv run pytest tests/test_main.py"],
    ["uv run pytest", "uv run pytest -k 'not slow'"],
    ["uv run pytest --cov", "uv run pytest"],
    ["uv run pytest --cov --cov-fail-under=94", "uv run pytest --cov"],
    ["uv run pytest -x tests/", "uv run pytest tests/unit"],
    ["uv run pytest", "uv run python -m unittest"],
    ["uv run ruff check .", "uv run ruff check src"],
    ["uv run ruff check .", "uv run --frozen ruff format --check ."],
    ["uv run pytest --cov", "uv run pytest --cov --deselect tests/test_main.py::test_run"],
    ["uv run pytest tests/", "uv run pytest tests/ tests/"],
    // The same options on another package's pytest are not the same test run.
    ["uv run pytest --cov", "uv run --package api pytest --cov"],
  ]) {
    expect(workflowChange(workflow([run(before)]), workflow([run(after)]))).toEqual([
      "gate-weakened",
    ]);
  }
});

test("changing a step's pytest environment is not running the same command", () => {
  const step = (env?: Record<string, string>) => run("uv run pytest", env ? { env } : {});
  for (const [before, after] of [
    [workflow([step()]), workflow([step({ PYTEST_ADDOPTS: "-k 'not slow'" })])],
    [workflow([step({ PYTEST_ADDOPTS: "-v" })]), workflow([step({ PYTEST_ADDOPTS: "-x" })])],
    [workflow([step()]), workflow([step()], { env: { PYTEST_ADDOPTS: "--deselect tests/a.py" } })],
    [workflow([step()]), workflow([step({ PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1" })])],
    [workflow([step()]), workflow([step({ COVERAGE_RCFILE: "loose.cfg" })])],
  ]) {
    expect(workflowChange(before, after)).toEqual(["gate-weakened"]);
  }
  // Other variables, such as a database URL, do not change which tests run.
  expect(
    workflowChange(workflow([step()]), workflow([step({ DATABASE_URL: "postgres://db" })])),
  ).toEqual(["gate-edited"]);
});

test("a second coverage threshold on a pytest command could lower it, so it blocks", () => {
  expect(
    workflowChange(
      workflow([run("uv run pytest --cov --cov-fail-under=94")]),
      workflow([run("uv run pytest --cov --cov-fail-under=94 --cov-fail-under=0")]),
    ),
  ).toEqual(["gate-weakened"]);
});

test("a task runner file that changes a runner environment variable weakens its gate recipes", () => {
  const withEnv = (line: string) => `${line}\n${recipes(FULL_CHECK)}`;
  for (const [before, after] of [
    [recipes(FULL_CHECK), withEnv('export PYTEST_ADDOPTS := "-k smoke"')],
    [recipes(FULL_CHECK), withEnv('export PYTEST_DISABLE_PLUGIN_AUTOLOAD := "1"')],
    [withEnv('export PYTEST_ADDOPTS := "-v"'), withEnv('export PYTEST_ADDOPTS := "-x"')],
    [recipes(FULL_CHECK), withEnv("set dotenv-load")],
    [
      recipes("PYTEST_ADDOPTS=-v uv run --frozen pytest"),
      recipes("PYTEST_ADDOPTS='-k smoke' uv run --frozen pytest"),
    ],
  ]) {
    expect(taskChange(before, after)).toEqual(["gate-weakened", "gate-weakened"]);
  }
  // Another variable, or a comment that names one, does not change which tests run.
  expect(
    taskChange(recipes(FULL_CHECK), withEnv('export DATABASE_URL := "postgres://db"')),
  ).toEqual(["gate-edited"]);
  expect(taskChange(recipes(FULL_CHECK), withEnv("# PYTEST_ADDOPTS stays unset here"))).toEqual([
    "gate-edited",
  ]);
});
