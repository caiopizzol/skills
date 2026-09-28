// Reports ways a change weakens a repository's tests or its test gate, from a unified diff.
// Pure: diff text in, findings out. `cli.ts` supplies the diff from git.
//
// Each finding has a severity. `block` findings (a deleted test file, an unconditional skip or
// focus, an added early return, a weakened gate) hold the change until someone records an
// exception. `report` findings (changed test content, fewer assertions, a skip that states its
// condition, other gate edits) are listed for review.

export type Rule =
  | "test-file-deleted"
  | "skip-or-focus-added"
  | "conditional-skip-added"
  | "early-exit-added"
  | "assertions-decreased"
  | "test-content-changed"
  | "gate-weakened"
  | "gate-edited";

export type Severity = "block" | "report";

export interface Finding {
  rule: Rule;
  severity: Severity;
  file: string;
  detail: string;
}

const SEVERITY: Record<Rule, Severity> = {
  "test-file-deleted": "block",
  "skip-or-focus-added": "block",
  "early-exit-added": "block",
  "gate-weakened": "block",
  "conditional-skip-added": "report",
  "assertions-decreased": "report",
  "test-content-changed": "report",
  "gate-edited": "report",
};

interface FileDiff {
  path: string;
  // The path before the change; differs from `path` only for a rename.
  from: string;
  deleted: boolean;
  added: string[];
  removed: string[];
  // Unchanged lines the diff shows around the edits.
  context: string[];
}

const TEST_FILE = /(^|\/)(__tests__|tests?|browser-tests)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;
const EXPECTED_OUTPUT = /(^|\/)(__snapshots__|expected)\/|\.snap$/;
const RUNNER_CONFIG = /(^|\/)(playwright|vitest|jest)\.config\.[cm]?[jt]s$|(^|\/)bunfig\.toml$/;
const AGENT_GATE = /(^|\/)\.agent-gate$/;
const WORKFLOW = /^\.github\/workflows\//;
// A workflow line that runs part of the gate, as opposed to release, deploy, or setup steps: a
// one-line `run:` step, or a command line inside a multi-line `run: |` block.
// A gate tool invoked as a command: `bun test`, `bun run check`, `vp check`, `npx vitest`, `tsc`.
// Words such as `test` in `test -n "$VAR"` (the shell builtin) or in an echo are not gate commands.
const GATE_TOOL =
  /(?:^|&&|;|\|\|)\s*(?:(?:bun|bunx|npx|pnpm|yarn|npm|vp)\s+(?:run\s+|x\s+)?)?(check|verify|test|lint|typecheck|tsc|biome|playwright|vitest)(?![\w-])(?!\s+-[a-z]\s)/;
const RUN_PREFIX = /^\s*-?\s*run:\s*/;
function isGateLine(line: string): boolean {
  const command = line.replace(RUN_PREFIX, "").trim();
  if (command === "" || command === "|" || command === ">" || command.startsWith("#")) return false;
  // A YAML key such as `name: Run tests` or `with:` is not a command.
  if (!RUN_PREFIX.test(line) && /^[\w-]+:/.test(command)) return false;
  return GATE_TOOL.test(command);
}
const GATE_STEP = { test: isGateLine };
const SKIP_OR_FOCUS =
  /\b(?:(?:it|test|describe|suite)\.(?:skip|only|todo|fixme|skipIf|runIf)|x(?:it|test|describe))\s*\(/;
// Playwright's conditional skip: `test.skip(condition, "reason")`, called inside a test or hook,
// with no test title and body. It may span lines, so the call's arguments are read from the added
// text that follows the marker.
const CONDITIONAL_SKIP_START = /\btest\.skip\s*\(\s*$|\btest\.skip\s*\(\s*[^"'`\s]/;
const ASSERTION = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(/g;
// A guard that leaves a test before its assertions without a value: `if (process.env.CI) return;`.
// A bare `return` gives up; `return value` is a helper, a mock, or a retry loop answering, and
// those are ordinary test code.
const EARLY_EXIT = /^\s*if\s*\(.+\)\s*(?:\{\s*)?return\s*;?\s*\}?\s*$/;
const GATE_SCRIPT = /^\s*"(check|verify|test)"\s*:\s*"(.*)"\s*,?\s*$/;

// The commands a gate script chains with `&&`.
const segments = (command: string) =>
  command
    .split("&&")
    .map((part) => part.trim())
    .filter(Boolean);

// Gate scripts whose new command drops any command the old one ran. Adding commands is not a
// weakening; removing or replacing one is.
function weakenedScripts(file: FileDiff): string[] {
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (const line of file.removed) {
    const match = GATE_SCRIPT.exec(line);
    if (match) before.set(match[1] ?? "", match[2] ?? "");
  }
  for (const line of file.added) {
    const match = GATE_SCRIPT.exec(line);
    if (match) after.set(match[1] ?? "", match[2] ?? "");
  }
  const weakened: string[] = [];
  for (const [name, old] of before) {
    const next = after.get(name);
    const kept = next === undefined ? [] : segments(next);
    if (segments(old).some((part) => !kept.includes(part))) weakened.push(name);
  }
  return weakened;
}

// The package scripts after the change, so a removed workflow step can be matched to a script
// that still runs it. `scripts` holds only the lines this diff added or kept in view.
function scriptsAfter(files: FileDiff[]): Map<string, string> {
  const scripts = new Map<string, string>();
  for (const file of files.filter((f) => /(^|\/)package\.json$/.test(f.path))) {
    for (const line of file.added) {
      const match = /^\s*"([\w:.-]+)"\s*:\s*"(.*)"\s*,?\s*$/.exec(line);
      if (match) scripts.set(match[1] ?? "", match[2] ?? "");
    }
  }
  return scripts;
}

// The command a workflow line executes, with `bun run x` and `bun x` naming the same script.
function stepCommand(line: string): string {
  return line.replace(RUN_PREFIX, "").trim();
}
function normalize(command: string): string {
  return command
    .replace(/^bun run /, "")
    .replace(/^bun /, "")
    .replace(/^npm run /, "")
    .trim();
}

// The commands a named script runs, following `bun run <script>` references one level into the
// scripts this change defines. `bun run format:check` and `prettier --check .` are the same when
// the script `format:check` is `prettier --check .`, but that script may not be in this diff; the
// caller passes the scripts it can see.
function expand(command: string, scripts: Map<string, string>): string[] {
  const direct = normalize(command);
  const body = scripts.get(direct);
  return body ? [direct, ...segments(body).map(normalize)] : [direct];
}

// A removed gate step is still covered when a remaining step, or a script it runs (also when that
// script is changed in the same diff), runs the same command. `bun test` and `bun run test` are the
// same step. `known` holds tool commands whose script bodies are known: a removed
// `bun run typecheck` is covered by a remaining `tsc --noEmit` only when the repository's
// `typecheck` script is exactly that, so unresolvable names do not count as covered.
function stillCovered(
  removed: string,
  remainingSteps: string[],
  scripts: Map<string, string>,
  known: Map<string, string>,
): boolean {
  const target = normalize(stepCommand(removed));
  const targetBody = known.get(target);
  const targets = new Set([target, ...(targetBody ? segments(targetBody).map(normalize) : [])]);
  for (const step of remainingSteps) {
    for (const part of expand(stepCommand(step), scripts)) {
      if (targets.has(part)) return true;
    }
  }
  return false;
}

export class UnparseableDiff extends Error {}

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // Git quotes paths with unusual characters ("a/…"). They cannot be classified reliably, so
      // the whole diff is refused rather than read wrongly.
      const header = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!header)
        throw new UnparseableDiff(`unsupported file path in diff header: ${line.slice(0, 200)}`);
      const [, from = "", path = ""] = header;
      current = { path, from, deleted: false, added: [], removed: [], context: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("deleted file mode")) current.deleted = true;
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    else if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (line.startsWith(" ")) current.context.push(line.slice(1));
  }
  return files;
}

const count = (lines: string[], pattern: RegExp) =>
  lines.reduce((sum, line) => sum + (line.match(pattern)?.length ?? 0), 0);

// A line counts as changed only when it carries content; blank lines and whitespace-only edits are
// formatting.
const meaningful = (lines: string[]) => lines.filter((line) => line.trim() !== "");

// A Playwright conditional skip names a condition and a reason instead of a title and a body:
// `test.skip(info.project.name === "desktop", "Covered separately.")`. The call's text starts at the
// marker line and may continue on the lines that follow it.
function isConditionalSkip(lines: string[], at: number): boolean {
  if (!CONDITIONAL_SKIP_START.test(lines[at] ?? "")) return false;
  const call = lines.slice(at, at + 6).join(" ");
  const args = call.slice(call.indexOf("test.skip(") + "test.skip(".length);
  const hasReason = /,\s*["'`][^"'`]+["'`]\s*,?\s*\)/.test(args);
  const hasBody = /=>|function\s*\(/.test(args.split(")")[0] ?? "");
  return hasReason && !hasBody;
}

// `known` maps script names to their commands in the repository after the change, for scripts the
// diff does not touch (see cli.ts). Tests may omit it.
export function detect(diff: string, known: Map<string, string> = new Map()): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: Rule, file: string, detail: string) =>
    findings.push({ rule, severity: SEVERITY[rule], file, detail });

  const files = parseDiff(diff);
  const scripts = new Map([...known, ...scriptsAfter(files)]);
  for (const file of files) {
    const { path } = file;
    // Expected-output files live under test directories but have their own rule below.
    const isExpected = EXPECTED_OUTPUT.test(path);
    const isTest = TEST_FILE.test(path) && !isExpected;
    // A rename that moves a test file out of the test patterns takes it out of the suite.
    const wasTest = TEST_FILE.test(file.from) && !EXPECTED_OUTPUT.test(file.from);
    if (file.from !== path && wasTest && !isTest) {
      add("test-file-deleted", file.from, `test file renamed out of the test suite, to ${path}`);
    }

    if (isTest && file.deleted) add("test-file-deleted", path, "test file deleted");
    if (isTest) {
      file.added.forEach((line, at) => {
        if (!SKIP_OR_FOCUS.test(line) || file.removed.some((r) => r.trim() === line.trim())) return;
        add(
          isConditionalSkip(file.added, at) ? "conditional-skip-added" : "skip-or-focus-added",
          path,
          line.trim(),
        );
      });
      // An added guard that returns early skips the test's assertions silently, like a skip.
      for (const line of file.added) {
        if (EARLY_EXIT.test(line) && !file.removed.some((r) => r.trim() === line.trim())) {
          add("early-exit-added", path, line.trim());
        }
      }
      // Counted per file: assertions added to one file do not hide ones removed from another.
      const added = count(file.added, ASSERTION);
      const removedAssertions = count(file.removed, ASSERTION);
      if (!file.deleted && removedAssertions > added) {
        add(
          "assertions-decreased",
          path,
          `${removedAssertions} assertion(s) removed, ${added} added`,
        );
      }
      const removed = meaningful(file.removed);
      if (!file.deleted && removed.length > 0) {
        add("test-content-changed", path, `${removed.length} existing line(s) changed or removed`);
      }
    }
    if (isExpected && (file.deleted || meaningful(file.removed).length > 0)) {
      add(
        "test-content-changed",
        path,
        file.deleted ? "expected output deleted" : "expected output changed",
      );
    }
    const edited = meaningful(file.added).length + meaningful(file.removed).length > 0;
    if (AGENT_GATE.test(path) && (file.deleted || meaningful(file.removed).length > 0)) {
      add("gate-weakened", path, "the agent gate command was changed or removed");
    }
    if (WORKFLOW.test(path)) {
      // Steps that still run after the change: added ones, and unchanged ones the diff shows.
      const remaining = [...file.added, ...file.context].filter((line) => GATE_STEP.test(line));
      const dropped = file.removed.filter(
        (line) => GATE_STEP.test(line) && !stillCovered(line, remaining, scripts, scripts),
      );
      // Deleting a workflow weakens the gate only when that workflow ran gate steps; a deploy or
      // release workflow is not part of the gate.
      if (file.deleted && dropped.length > 0) {
        add("gate-weakened", path, `workflow with gate steps deleted: ${dropped[0]?.trim()}`);
      } else if (dropped.length > 0) {
        add("gate-weakened", path, `gate step removed: ${dropped[0]?.trim()}`);
      } else if (edited) {
        add("gate-edited", path, "workflow changed");
      }
    }
    if (RUNNER_CONFIG.test(path) && edited)
      add("gate-edited", path, "test runner configuration changed");
    if (/(^|\/)package\.json$/.test(path)) {
      for (const name of weakenedScripts(file)) {
        add("gate-weakened", path, `the "${name}" script no longer runs everything it did`);
      }
    }
  }
  return findings;
}
