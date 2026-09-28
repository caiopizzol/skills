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

// Test directories, JavaScript test files, and the files pytest collects by default
// (`test_*.py`, `*_test.py`) with its shared fixtures (`conftest.py`).
const TEST_FILE =
  /(^|\/)(__tests__|tests?|browser-tests)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/;
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

// The shell a step runs in, and whether a failing command stops it. With no shell set, GitHub runs
// `bash -e` on Linux and macOS runners and PowerShell on Windows, where a failing native command
// does not stop the script. `bash` and `sh` stop on errors. With no shell set, only a GitHub-hosted
// Linux or macOS label counts as stopping; a self-hosted runner may be Windows, and a runner chosen
// by an expression is unknown.
const HOSTED_UNIX = /^(?:ubuntu|macos)-(?:latest|\d[\w.-]*)$/;
function stepShell(
  step: Record<string, unknown>,
  job: Record<string, unknown>,
  root: Record<string, unknown>,
): { shell: string; failFast: boolean } {
  const set = step.shell ?? defaultShell(job) ?? defaultShell(root);
  if (set !== undefined) return { shell: scalar(set), failFast: set === "bash" || set === "sh" };
  const runsOn = job["runs-on"];
  const known = typeof runsOn === "string" && HOSTED_UNIX.test(runsOn);
  return { shell: `default on ${scalar(runsOn ?? null)}`, failFast: known };
}

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
      const shell = stepShell(step, job, root);
      const scope = JSON.stringify([
        id,
        scalar(job.if ?? null),
        scalar(job["continue-on-error"] ?? null),
        scalar(step.if ?? null),
        scalar(step["continue-on-error"] ?? null),
        directory,
        shell.shell,
      ]);
      // Under GitHub's `bash -e`, a failing command stops the step, except on the left of `&&` on
      // a line other than the last command line; the last line's status is the step's.
      const lines = script.split("\n");
      const last = lines.findLastIndex(
        (line) => line.trim() !== "" && !line.trim().startsWith("#"),
      );
      const plain = shell.failFast && lines.every(isPlainLine);
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

// The index of the quote that closes the string opened at `open`, honoring backslash escapes, or
// undefined when the string does not close.
function stringEnd(text: string, open: number): number | undefined {
  for (let at = open + 1; at < text.length; at++) {
    if (text[at] === "\\") at++;
    else if (text[at] === text[open]) return at;
  }
  return undefined;
}

// The arguments of the call whose opening parenthesis is at `open`, split at top-level commas, or
// undefined when the call does not close. Strings are skipped, so their commas and parentheses do
// not count.
function callArguments(text: string, open: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open; at < text.length; at++) {
    const char = text[at];
    if (char === '"' || char === "'" || char === "`") {
      const end = stringEnd(text, at);
      if (end === undefined) return undefined;
      at = end;
    } else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, at).trim());
        return args.filter((arg, index) => arg !== "" || index < args.length - 1);
      }
    } else if (char === "," && depth === 1) {
      args.push(text.slice(start, at).trim());
      start = at + 1;
    }
  }
  return undefined;
}

// A condition a skip may use: something the run decides, compared with a string, such as
// `info.project.name === "desktop"` or `process.platform !== "darwin"`, or such comparisons joined
// with `||` or `&&`. Whether an arbitrary expression can be false cannot be read from its text
// (`!!1`, or a constant set to `true`, never is), so any other condition counts as unconditional.
// The values each runtime can take are not known. A comparison with an impossible value
// (`process.platform !== "windows"`), or equalities that cover every value a repository uses
// (`process.platform === "darwin" || process.platform === "linux"`), still counts as conditional.
// Conditional skips are reported, not blocked, so a person reviews them.
// Joined comparisons of the same value can be always true (`p === "a" || p !== "a"`, or
// `p !== "a" || p !== "b"`), so `||` may join comparisons of different values only.
// Under `||`, a value may repeat only in `===` comparisons with different strings (`b === "x" ||
// b === "y"`): those can all be false together.
const STRING_LITERAL = /^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/;
// How a language writes a runtime value, a comparison, and `or` / `and`. `key` names a value so two
// spellings of the same one compare as the same.
interface ConditionSyntax {
  value: RegExp;
  operator: RegExp;
  joiner: RegExp;
  or: string;
  key: (value: string) => string;
}
const JAVASCRIPT_CONDITION: ConditionSyntax = {
  value:
    /^(?:(?:test)?[iI]nfo\.project\.name|process\.platform|process\.env\.[A-Z_][A-Z0-9_]*|browserName)/,
  operator: /^[!=]==?/,
  joiner: /^(?:\|\||&&)/,
  or: "||",
  key: (value) => value.replace(/^testInfo/, "info"),
};
// `sys.platform`, `os.name`, `platform.system()`, or an environment variable read with
// `os.environ.get("NAME")`, `os.getenv("NAME")`, or `os.environ["NAME"]`.
const ENVIRONMENT_NAME = String.raw`\s*(?:"[A-Z_][A-Z0-9_]*"|'[A-Z_][A-Z0-9_]*')\s*`;
const PYTHON_CONDITION: ConditionSyntax = {
  value: new RegExp(
    String.raw`^(?:sys\.platform|os\.name|platform\.system\(\)|os\.environ\.get\(${ENVIRONMENT_NAME}\)|os\.getenv\(${ENVIRONMENT_NAME}\)|os\.environ\[${ENVIRONMENT_NAME}\])`,
  ),
  operator: /^[!=]=(?!=)/,
  joiner: /^(?:or|and)(?!\w)/,
  or: "or",
  key: (value) => {
    const name = /["']([A-Z_][A-Z0-9_]*)["']/.exec(value)?.[1];
    return name ? `env:${name}` : value;
  },
};
interface Comparison {
  value: string;
  equal: boolean;
  text: string;
}
// The condition as comparisons and the one operator joining them, read token by token so quotes and
// operators inside strings are not mistaken for structure. Undefined for anything else.
function comparisons(
  condition: string,
  syntax: ConditionSyntax,
): { parts: Comparison[]; joiner?: string } | undefined {
  const parts: Comparison[] = [];
  const joiners = new Set<string>();
  let rest = condition.trim();
  while (true) {
    const value = syntax.value.exec(rest)?.[0];
    if (!value) return undefined;
    rest = rest.slice(value.length).trimStart();
    const operator = syntax.operator.exec(rest)?.[0];
    if (!operator) return undefined;
    rest = rest.slice(operator.length).trimStart();
    const text = STRING_LITERAL.exec(rest)?.[0];
    if (!text) return undefined;
    rest = rest.slice(text.length).trimStart();
    parts.push({ value: syntax.key(value), equal: operator[0] === "=", text });
    if (rest === "") break;
    const joiner = syntax.joiner.exec(rest)?.[0];
    if (!joiner) return undefined;
    joiners.add(joiner);
    rest = rest.slice(joiner.length).trimStart();
  }
  if (joiners.size > 1) return undefined;
  return { parts, joiner: [...joiners][0] };
}
// `negated` reads a condition that skips when it is false (`skipUnless`) as its opposite, which
// skips when true: `a == "x" and a == "y"` is always false, so its opposite always skips.
function isRuntimeCondition(condition: string, syntax: ConditionSyntax, negated = false): boolean {
  const read = comparisons(condition, syntax);
  if (!read) return false;
  const parts = negated ? read.parts.map((part) => ({ ...part, equal: !part.equal })) : read.parts;
  const joiner =
    negated && read.joiner !== undefined
      ? read.joiner === syntax.or
        ? "and"
        : syntax.or
      : read.joiner;
  if (joiner !== syntax.or) return true;
  const byValue = new Map<string, Comparison[]>();
  for (const part of parts) byValue.set(part.value, [...(byValue.get(part.value) ?? []), part]);
  return [...byValue.values()].every(
    (same) =>
      same.length === 1 ||
      (same.every((part) => part.equal) &&
        new Set(same.map((part) => part.text)).size === same.length),
  );
}
const PLAIN_REASON = /^(?:"(?:[^"\\\n]|\\.)+"|'(?:[^'\\\n]|\\.)+'|`[^`$\\]+`|[A-Za-z_$][\w$]*)$/;

// A Playwright conditional skip names a condition and a reason instead of a title and a body:
// `test.skip(info.project.name === "desktop", "Covered separately.")`. The reason may be a string or
// a named constant. The call starts at the marker line and may continue on later lines.
function isConditionalSkip(lines: string[], at: number): boolean {
  if (!CONDITIONAL_SKIP_START.test(lines[at] ?? "")) return false;
  const text = lines.slice(at, at + 6).join("\n");
  const args = callArguments(text, text.indexOf("(", text.indexOf("test.skip")));
  if (args?.length !== 2) return false;
  const [condition = "", reason = ""] = args;
  return isRuntimeCondition(condition, JAVASCRIPT_CONDITION) && PLAIN_REASON.test(reason);
}

// Python: pytest and unittest skip and expected-failure markers, as decorators (`@pytest.mark.skip`,
// `@mark.xfail`, `@unittest.skip`, `@skip`), as marks (`pytestmark = pytest.mark.skip`,
// `pytest.param(…, marks=pytest.mark.skip)`), and as calls or exceptions (`pytest.skip()`,
// `pytest.xfail()`, `pytest.importorskip()`, `self.skipTest()`, `raise unittest.SkipTest`), and
// the setting that stops pytest collecting a module or class (`__test__ = False`). A comment line is
// not a marker.
const PYTHON_SKIP =
  /^\s*@(?:\w+\.)*(?:skip|skipif|skipIf|skipUnless|xfail|expectedFailure)\b|\bmark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail|importorskip)\b|\bskipTest\s*\(|\bSkipTest\b|^\s*__test__\s*=\s*False\b/g;
const pythonMarkers = (line: string) =>
  /^\s*#/.test(line) ? 0 : (line.match(PYTHON_SKIP)?.length ?? 0);
// pytest reads `collect_ignore` and `collect_ignore_glob`, which stop it collecting paths, only from
// a `conftest.py`. Elsewhere they are ordinary names.
const CONFTEST = /(^|\/)conftest\.py$/;
const COLLECT_IGNORE = /^\s*[^#]*\bcollect_ignore(?:_glob)?\b/;
// A skip that names a condition and a reason, and nothing else:
// `@pytest.mark.skipif(os.name != "posix", reason="Requires SIGKILL")`. Each may be positional, in
// that order, or named (`condition=`, `reason=`) in any order. The reason may be adjacent string
// literals or a named constant. The call may continue on later lines. A line with another marker
// beside it is not read as conditional.
const PYTHON_CONDITIONAL = /\b(?:skipif|skipIf|skipUnless|xfail)\s*\(/;
const PYTHON_REASON = /^(?:(?:(?:"(?:[^"\\\n]|\\.)+"|'(?:[^'\\\n]|\\.)+')\s*)+|[A-Za-z_]\w*)$/;
function conditionAndReason(args: string[]): [string, string] | undefined {
  if (args.length !== 2) return undefined;
  const named = args.map((arg) => /^(condition|reason)\s*=(?!=)\s*([\s\S]*)$/.exec(arg));
  const [first, second] = named;
  if (!first && !second) return [args[0] ?? "", args[1] ?? ""];
  if (!first && second?.[1] === "reason") return [args[0] ?? "", second[2] ?? ""];
  if (first && second && first[1] !== second[1]) {
    return first[1] === "condition"
      ? [first[2] ?? "", second[2] ?? ""]
      : [second[2] ?? "", first[2] ?? ""];
  }
  return undefined;
}
function isConditionalPythonSkip(lines: string[], at: number): boolean {
  const line = lines[at] ?? "";
  const marker = PYTHON_CONDITIONAL.exec(line);
  if (!marker || pythonMarkers(line) !== 1) return false;
  const text = lines.slice(at, at + 6).join("\n");
  const args = callArguments(text, marker.index + marker[0].length - 1);
  const read = args && conditionAndReason(args);
  if (!read) return false;
  const [condition, reason] = read;
  const negated = marker[0].startsWith("skipUnless");
  return isRuntimeCondition(condition, PYTHON_CONDITION, negated) && PYTHON_REASON.test(reason);
}
// Python has no braces, so any added bare `return` in a test file gives up early, on its own line
// or after `if …:`. `return None` is the same statement, so it counts too, even in a helper.
const PYTHON_EARLY_EXIT = /^\s*(?:if\s.+:\s*)?return(?:\s+None)?\s*;?\s*(?:#.*)?$/;
const pythonEarlyExits = (lines: string[]) =>
  lines.filter((line) => PYTHON_EARLY_EXIT.test(line)).map((line) => line.trim());
// `assert` statements, unittest's `self.assert…()`, mocks' `.assert_called…()`, and
// `pytest.raises()` or `pytest.warns()`.
const PYTHON_ASSERTION =
  /^\s*assert\b|\bself\.assert\w*\s*\(|\.assert_\w+\s*\(|\bpytest\.(?:raises|warns)\s*\(/g;

// How each language marks a skipped test and gives up early. Python for `.py` files, JavaScript's
// rules for every other test file.
interface Language {
  isMarker: (line: string, path: string) => boolean;
  isConditional: (lines: string[], at: number) => boolean;
  earlyExits: (lines: string[]) => string[];
  assertion: RegExp;
}
const JAVASCRIPT: Language = {
  isMarker: (line) => SKIP_OR_FOCUS.test(line),
  isConditional: isConditionalSkip,
  earlyExits,
  assertion: ASSERTION,
};
const PYTHON: Language = {
  isMarker: (line, path) =>
    pythonMarkers(line) > 0 || (CONFTEST.test(path) && COLLECT_IGNORE.test(line)),
  isConditional: isConditionalPythonSkip,
  earlyExits: pythonEarlyExits,
  assertion: PYTHON_ASSERTION,
};

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
      const language = path.endsWith(".py") ? PYTHON : JAVASCRIPT;
      file.added.forEach((line, at) => {
        if (!language.isMarker(line, path) || file.removed.some((r) => r.trim() === line.trim()))
          return;
        add(
          language.isConditional(file.added, at) ? "conditional-skip-added" : "skip-or-focus-added",
          path,
          line.trim(),
        );
      });
      // An added guard that returns early skips the test's assertions silently, like a skip.
      const existing = new Set(language.earlyExits(file.removed));
      for (const guard of language.earlyExits(file.added)) {
        if (!existing.has(guard)) add("early-exit-added", path, guard);
      }
      // Counted per file: assertions added to one file do not hide ones removed from another.
      const added = count(file.added, language.assertion);
      const removedAssertions = count(file.removed, language.assertion);
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
