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
