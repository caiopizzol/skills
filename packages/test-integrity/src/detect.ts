// Reports ways a change weakens a repository's tests or its test gate, from a unified diff.
// Pure: diff text in, findings out. `cli.ts` supplies the diff from git.
//
// Each finding has a severity. `block` findings (a deleted test file, an unconditional skip or
// focus, an added early return, a weakened gate) hold the change until someone records an
// exception. `report` findings (changed test content, fewer assertions, a skip that states its
// condition, other gate edits) are listed for review.
//
// These are heuristics that catch common weakenings, not a proof. A determined change can still
// pass, for example a new `run` line that deletes tests before `bun test` runs, or a test that
// asserts less without removing an assertion call. Every gate edit is still reported for review.

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
}

// A changed workflow's parsed YAML at the merge base and at the head, `null` where the file does
// not exist. `cli.ts` reads them.
export interface WorkflowVersions {
  before: unknown;
  after: unknown;
}

// What the repository runs after the change, which the diff alone does not show: the root
// package's scripts, and each changed workflow in full.
export interface Head {
  scripts?: Map<string, string>;
  workflows?: Map<string, WorkflowVersions>;
}

const TEST_FILE = /(^|\/)(__tests__|tests?|browser-tests)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;
const EXPECTED_OUTPUT = /(^|\/)(__snapshots__|expected)\/|\.snap$/;
const RUNNER_CONFIG = /(^|\/)(playwright|vitest|jest)\.config\.[cm]?[jt]s$|(^|\/)bunfig\.toml$/;
const AGENT_GATE = /(^|\/)\.agent-gate$/;
export const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
// A gate tool invoked as a command, as opposed to release, deploy, or setup commands: `bun test`,
// `bun run check`, `vp check`, `npx vitest`, `tsc`, also after `then`, `do`, or `else`, or behind
// environment assignments (`CI=1 bun test`). Words such as `test` in `test -n "$VAR"` (the shell
// builtin) or in an echo are not gate commands.
const GATE_TOOL =
  /(?:^|&&|;|\|\||\b(?:then|do|else)\s)\s*(?:\w+=\S*\s+)*(?:(?:bun|bunx|npx|pnpm|yarn|npm|vp)\s+(?:run\s+|x\s+)?)?(check|verify|test|lint|typecheck|tsc|biome|playwright|vitest)(?![\w-])(?!\s+-[a-z]\s)/;
const SKIP_OR_FOCUS =
  /\b(?:(?:it|test|describe|suite)\.(?:skip|only|todo|fixme|skipIf|runIf)|x(?:it|test|describe))\s*\(/;
// Playwright's conditional skip: `test.skip(condition, "reason")`, called inside a test or hook,
// with no test title and body. It may span lines, so the call's arguments are read from the added
// text that follows the marker.
const CONDITIONAL_SKIP_START = /\btest\.skip\s*\(\s*$|\btest\.skip\s*\(\s*[^"'`\s]/;
const ASSERTION = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(/g;
// A guard that leaves a test before its assertions without a value: `if (process.env.CI) return;`,
// or the same guard over three lines (`if (…) {`, `return;`, `}`).
// A bare `return` gives up; `return value` is a helper, a mock, or a retry loop answering, and
// those are ordinary test code.
const EARLY_EXIT = /^\s*if\s*\(.+\)\s*(?:\{\s*)?return\s*;?\s*\}?\s*$/;
const GUARD_OPEN = /^\s*if\s*\(.+\)\s*\{\s*$/;
const BARE_RETURN = /^\s*return\s*;?\s*$/;
const CLOSE = /^\s*\}\s*$/;
function earlyExits(lines: string[]): string[] {
  const found: string[] = [];
  lines.forEach((line, at) => {
    if (EARLY_EXIT.test(line)) found.push(line.trim());
    else if (
      GUARD_OPEN.test(line) &&
      BARE_RETURN.test(lines[at + 1] ?? "") &&
      CLOSE.test(lines[at + 2] ?? "")
    ) {
      found.push(`${line.trim()} return; }`);
    }
  });
  return found;
}
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

// A package script by name: `bun run x` and `npm run x` run the script `x`, and `npm test`,
// `pnpm test`, and `yarn test` run `test`. `bun test` is Bun's test runner, not the `test` script,
// so it stays as written.
function normalize(command: string): string {
  return command
    .trim()
    .replace(/^(?:bun|npm|pnpm|yarn)\s+run\s+/, "")
    .replace(/^(?:npm|pnpm|yarn)\s+test$/, "test");
}

// A command, and when it names a script, the commands that script runs, one level deep.
function expand(command: string, scripts: Map<string, string>): string[] {
  const name = normalize(command);
  const body = scripts.get(name);
  return body ? [name, ...segments(body).map(normalize)] : [name];
}

// A gate command in a workflow, with where and when it runs: the workflow's pull request triggers,
// its job, the job's and step's `if` and `continue-on-error`, and its working directory. A command
// stands in for another only with the same scope and triggers at least as broad, so a push-only or
// narrowed workflow, another job, a skipped or non-blocking step, or another package's directory
// never counts as still running it. Conditions compare as text: rewriting `if: success()` as
// `if: ${{ success() }}` counts as a change and blocks.
// Not followed: matrix values, reusable workflows, and actions. Editing them only reports.
interface GateCommand {
  scope: string;
  triggers: Triggers;
  atRoot: boolean;
  command: string;
  // The step's whole `run` text, and whether a failure of this command always fails the step.
  run: string;
  fails: boolean;
}

// A plain command: an unquoted command name, then words, flags, quoted text without expansions, and
// redirections, after optional `NAME=value` assignments. Under GitHub's default `bash -e`, a plain
// command that fails stops the step. Anything else could skip a later command or hide its failure,
// such as control flow, `;`, `|`, `&`, `$` expansions, `${{ }}` expressions, or substitutions.
// So a block with anything else does not count, nor one with a builtin that changes control flow,
// error handling, the directory (`cd` narrows what a later `bun test` runs), or the environment.
const WORD = String.raw`[\w./@:=,+%*?~-]+`;
const TOKEN = String.raw`(?:${WORD}|"[^"$\`\\]*"|'[^']*'|\d?>>?(?:&\d|\s*[\w./-]+)|<\s*[\w./-]+)`;
const PLAIN_COMMAND = new RegExp(String.raw`^(?:\w+=${WORD}\s+)*(${WORD})(?:\s+${TOKEN})*$`);
const CONTROL_BUILTIN =
  /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function|time|coproc|exit|exec|trap|set|shopt|source|\.|eval|builtin|command|return|break|continue|alias|cd|pushd|popd|export|unset|declare|typeset|readonly|local|enable|hash|umask|ulimit)$/;
const isPlainLine = (line: string) =>
  line.trim() === "" ||
  line.trim().startsWith("#") ||
  segments(line).every((part) => {
    const name = PLAIN_COMMAND.exec(part)?.[1];
    return name !== undefined && !CONTROL_BUILTIN.test(name);
  });

const fields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const runDefault = (value: unknown, key: string) => {
  const setting = fields(fields(fields(value).defaults).run)[key];
  return typeof setting === "string" ? setting : undefined;
};
const defaultDirectory = (value: unknown) => runDefault(value, "working-directory");
const defaultShell = (value: unknown) => runDefault(value, "shell");

// A YAML value as part of a scope. Conditions and filters are scalars or short lists of them. Any
// other value, such as a mapping or a large alias graph that would grow when serialized, gets a
// key that matches nothing, so a command under it is never counted as still running.
let unmatched = 0;
function scalar(value: unknown): string {
  const plain = (v: unknown) =>
    v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string";
  const items = Array.isArray(value) ? value : [value];
  const size = items.reduce<number>((sum, v) => sum + (typeof v === "string" ? v.length : 8), 0);
  if (items.length <= 100 && size <= 4096 && items.every(plain)) return JSON.stringify(value);
  unmatched += 1;
  return `unmatched:${unmatched}`;
}

// The pull request events a workflow runs on, each with its filters (`types`, `branches`, `paths`)
// as comparable text.
type Triggers = Map<string, Map<string, string>>;
const PULL_REQUEST_EVENTS = ["pull_request", "pull_request_target"];
function pullRequestTriggers(on: unknown): Triggers {
  const listed = typeof on === "string" ? [on] : Array.isArray(on) ? on : undefined;
  const triggers: Triggers = new Map();
  for (const event of PULL_REQUEST_EVENTS) {
    if (listed ? !listed.includes(event) : !(event in fields(on))) continue;
    const filters = listed ? {} : fields(fields(on)[event]);
    triggers.set(
      event,
      new Map(Object.entries(filters).map(([key, value]) => [key, scalar(value)])),
    );
  }
  return triggers;
}

// Triggers at least as broad as `before`: every event still fires, with each filter it keeps
// unchanged. Removing a filter widens a trigger; adding or changing one may narrow it.
const asBroad = (after: Triggers, before: Triggers) =>
  [...before].every(([event, filters]) => {
    const kept = after.get(event);
    return kept !== undefined && [...kept].every(([key, value]) => filters.get(key) === value);
  });

// Every step's commands are read, and anchors let a small file repeat a large `run:` many times, so
// the text read is bounded.
const MAX_RUN_CHARACTERS = 1024 * 1024;

function gateCommandsIn(workflow: unknown): GateCommand[] {
  const root = fields(workflow);
  const triggers = pullRequestTriggers(root.on);
  const found: GateCommand[] = [];
  let read = 0;
  for (const [id, value] of Object.entries(fields(root.jobs))) {
    const job = fields(value);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const item of steps) {
      const step = fields(item);
      const script = step.run;
      if (typeof script !== "string") continue;
      read += script.length;
      if (read > MAX_RUN_CHARACTERS) throw new Error("a workflow runs too much text to read");
      const own = step["working-directory"];
      const directory =
        (typeof own === "string" ? own : undefined) ??
        defaultDirectory(job) ??
        defaultDirectory(root) ??
        ".";
      const scope = JSON.stringify([
        id,
        scalar(job.if ?? null),
        scalar(job["continue-on-error"] ?? null),
        scalar(step.if ?? null),
        scalar(step["continue-on-error"] ?? null),
        directory,
        scalar(step.shell ?? defaultShell(job) ?? defaultShell(root) ?? null),
      ]);
      // Under GitHub's `bash -e`, a failing command stops the step, except on the left of `&&` on
      // a line other than the last command line; the last line's status is the step's.
      const lines = script.split("\n");
      const last = lines.findLastIndex(
        (line) => line.trim() !== "" && !line.trim().startsWith("#"),
      );
      const plain = lines.every(isPlainLine);
      lines.forEach((line, at) => {
        for (const command of segments(line).filter((part) => GATE_TOOL.test(part))) {
          const fails = plain && (at === last || !line.includes("&&"));
          found.push({
            scope,
            triggers,
            atRoot: /^\.\/?$/.test(directory),
            command,
            run: script,
            fails,
          });
        }
      });
    }
  }
  return found;
}

// The gate commands a workflow change stops running. A command still runs when a step with the same
// scope, on triggers at least as broad, runs it after the change: by name, or at the root, through
// a root script that runs it, or because every command of its own script still runs. A new or
// changed `run` block counts only where a failure of the command fails the step; an unchanged one
// counts as it did before.
function droppedCommands(versions: WorkflowVersions, scripts: Map<string, string>): string[] {
  const before = gateCommandsIn(versions.before);
  const unchanged = new Set(before.map((c) => `${c.scope}\n${c.run}`));
  const after = gateCommandsIn(versions.after).filter(
    (c) => c.fails || unchanged.has(`${c.scope}\n${c.run}`),
  );
  return before
    .filter(({ scope, triggers, atRoot, command }) => {
      const known = atRoot ? scripts : new Map<string, string>();
      const ran = new Set(
        after
          .filter((c) => c.scope === scope && asBroad(c.triggers, triggers))
          .flatMap((c) => expand(c.command, known)),
      );
      const name = normalize(command);
      const body = known.get(name);
      const stillRuns =
        ran.has(name) ||
        (body !== undefined && segments(body).every((part) => ran.has(normalize(part))));
      return !stillRuns;
    })
    .map((c) => c.command);
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
      current = { path, from, deleted: false, added: [], removed: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("deleted file mode")) current.deleted = true;
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    else if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
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

// `head` supplies what the diff does not show (see cli.ts). Every changed workflow must be in it.
export function detect(diff: string, head: Head = {}): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: Rule, file: string, detail: string) =>
    findings.push({ rule, severity: SEVERITY[rule], file, detail });

  const scripts = head.scripts ?? new Map<string, string>();
  for (const file of parseDiff(diff)) {
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
      const existing = new Set(earlyExits(file.removed));
      for (const guard of earlyExits(file.added)) {
        if (!existing.has(guard)) add("early-exit-added", path, guard);
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
    if (WORKFLOW.test(path) || WORKFLOW.test(file.from)) {
      const versions = head.workflows?.get(path);
      if (!versions) throw new Error(`the contents of ${path} were not supplied`);
      const dropped = droppedCommands(versions, scripts);
      // Deleting a workflow weakens the gate only when that workflow ran gate commands; a deploy or
      // release workflow is not part of the gate.
      if (versions.after === null && dropped.length > 0) {
        add("gate-weakened", path, `workflow with gate commands deleted: ${dropped[0]}`);
      } else if (dropped.length > 0) {
        add("gate-weakened", path, `gate command removed or no longer enforced: ${dropped[0]}`);
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
