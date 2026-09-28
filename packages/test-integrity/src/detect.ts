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

// A changed `justfile` or `Makefile`'s text at the merge base and at the head, `null` where the file
// does not exist.
export interface TextVersions {
  before: string | null;
  after: string | null;
}

// What the repository runs after the change, which the diff alone does not show: the root
// package's scripts, and each changed workflow, task runner file, and `pyproject.toml` in full.
// `pyprojects` holds parsed TOML, like `workflows` holds parsed YAML.
export interface Head {
  scripts?: Map<string, string>;
  workflows?: Map<string, WorkflowVersions>;
  taskFiles?: Map<string, TextVersions>;
  pyprojects?: Map<string, WorkflowVersions>;
}

// Test directories, JavaScript test files, and the files pytest collects by default
// (`test_*.py`, `*_test.py`) with its shared fixtures (`conftest.py`).
const TEST_FILE =
  /(^|\/)(__tests__|tests?|browser-tests)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/;
const EXPECTED_OUTPUT = /(^|\/)(__snapshots__|expected)\/|\.snap$/;
// Test runner configuration: JavaScript runners' config files, and pytest's and coverage's own
// files, where options such as `addopts`, `-k`, `--deselect`, or `testpaths` choose which tests run.
// In `pyproject.toml`, only the `tool.pytest` and `tool.coverage` tables are (see `PYPROJECT`).
const RUNNER_CONFIG =
  /(^|\/)(playwright|vitest|jest)\.config\.[cm]?[jt]s$|(^|\/)bunfig\.toml$|(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|\.coveragerc)$/;
export const PYPROJECT = /(^|\/)pyproject\.toml$/;
export const TASK_RUNNER = /(^|\/)(justfile|Justfile|\.justfile|Makefile|makefile|GNUmakefile)$/;
const AGENT_GATE = /(^|\/)\.agent-gate$/;
export const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
// A gate tool invoked as a command, as opposed to release, deploy, or setup commands: `bun test`,
// `bun run check`, `vp check`, `npx vitest`, `tsc`, also after `then`, `do`, or `else`, or behind
// environment assignments (`CI=1 bun test`). Words such as `test` in `test -n "$VAR"` (the shell
// builtin, which a single-letter flag follows) or in an echo are not gate commands. Other tools'
// names are not shell builtins, so `pytest -x` is a gate command.
// Python tools run directly, through `uv run` (with its flags, some of which take a value, such as
// `--with pytest-cov`), `python -m`, or `poetry run`, and `just` or `make` recipes:
// `uv run --frozen pytest`, `python -m pytest`, `just check`.
const GATE_TOOL =
  /(?:^|&&|;|\|\||\b(?:then|do|else)\s)\s*(?:\w+=\S*\s+)*(?:(?:bun|bunx|npx|pnpm|yarn|npm|vp)\s+(?:run\s+|x\s+)?|uv\s+run\s+(?:(?:--(?:with|with-editable|with-requirements|group|extra|package|python|project|directory|env-file|index)|-[pw])(?:=|\s+)\S+\s+|--?[\w-]+(?:=\S+)?\s+)*|(?:python3?|uv\s+run\s+python3?)\s+-m\s+|poetry\s+run\s+|(?:just|make)\s+)?(test(?![\w-])(?!\s+-[a-z]\s)|(?:check|verify|lint|typecheck|tsc|biome|playwright|vitest|pytest|ruff|pyright|mypy|tox|nox)(?![\w-]))/;
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
    if (!runsAll(segments(old), kept)) weakened.push(name);
  }
  return weakened;
}

// A `justfile` or `Makefile`'s recipes: a `name params: dependencies` line at the start of a line,
// then its indented command lines. Comments, attributes, settings, assignments, and special targets
// such as `.PHONY` are not recipes. A command line may continue over lines ending in `\`.
interface Recipe {
  dependencies: string[];
  commands: string[];
}
const RECIPE_HEADER = /^@?([A-Za-z_][\w-]*)([^:#]*?):(?!=)(.*)$/;
const NOT_RECIPE = /^(?:set|export|alias|import|mod|include|define|override|unexport|vpath)$/;
function readRecipes(text: string): Map<string, Recipe> {
  const found = new Map<string, Recipe>();
  let current: Recipe | undefined;
  for (const line of text.replace(/\\\r?\n[ \t]*/g, " ").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (/^[ \t]/.test(line)) {
      // `@` only stops a line being echoed; `-` ignores its failure, so it stays part of the text.
      const command = line.trim().replace(/^@/, "").replace(/\s+/g, " ");
      if (current && !command.startsWith("#")) current.commands.push(...segments(command));
      continue;
    }
    current = undefined;
    const header = RECIPE_HEADER.exec(line);
    if (!header || NOT_RECIPE.test(header[1] ?? "")) continue;
    // Make runs the text after a `;` on the header line as the recipe's first command.
    const [prerequisites = "", ...inline] = (header[3] ?? "").split(";");
    // Dependencies are names, some with arguments in parentheses; quoted arguments are not names.
    const listed = prerequisites.replace(/#.*$/, "").replace(/"[^"]*"|'[^']*'/g, "");
    current = { dependencies: listed.match(/[A-Za-z_][\w-]*/g) ?? [], commands: [] };
    const command = inline.join(";").trim().replace(/^@/, "").replace(/\s+/g, " ");
    if (command !== "") current.commands.push(...segments(command));
    found.set(header[1] ?? "", current);
  }
  return found;
}

// Every command a recipe runs, through its dependencies. A dependency the file does not define
// counts by name.
function recipeCommands(
  all: Map<string, Recipe>,
  name: string,
  seen = new Set<string>(),
): string[] {
  const recipe = all.get(name);
  if (!recipe) return [`recipe ${name}`];
  if (seen.has(name)) return [];
  seen.add(name);
  return [
    ...recipe.dependencies.flatMap((dependency) => recipeCommands(all, dependency, seen)),
    ...recipe.commands,
  ];
}

// Gate recipes (`check`, `verify`, `test`) that no longer run a command they ran before. Adding
// commands is not a weakening; removing or changing one is, as for package scripts.
// A gate recipe also stops running what it did when the file changes a runner environment variable
// (`PYTEST_ADDOPTS`, see `RUNNER_ENVIRONMENT`): as an `export`, a `set dotenv-load`, or an
// assignment, anywhere in the file, since `export` reaches every recipe. Lines that mention one are
// compared whole.
const environmentLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /\b(?:PYTEST_\w*|COVERAGE_\w*|PYTHON\w*)\b|^set\s+(?:dotenv|export)/.test(line),
    )
    .filter((line) => !line.startsWith("#"));
function weakenedRecipes(versions: TextVersions): string[] {
  const before = readRecipes(versions.before ?? "");
  const after = readRecipes(versions.after ?? "");
  const was = environmentLines(versions.before ?? "");
  const now = environmentLines(versions.after ?? "");
  const environmentChanged = was.length !== now.length || was.some((line, at) => line !== now[at]);
  return ["check", "verify", "test"].filter((name) => {
    if (!before.has(name)) return false;
    if (environmentChanged) return true;
    const kept = after.has(name) ? recipeCommands(after, name) : [];
    return !runsAll(recipeCommands(before, name), kept);
  });
}

// pytest's and coverage's settings in a `pyproject.toml`: `tool.pytest` and `tool.coverage`. The
// rest of the file, such as the version a release bumps, is not part of the gate.
const testSettings = (value: unknown) => {
  const tool = fields(fields(value).tool);
  return JSON.stringify([tool.pytest ?? null, tool.coverage ?? null]);
};

// pytest settings that choose which tests run, and coverage's minimum. A change that could narrow
// the run or lower the minimum blocks: `addopts` losing any option or gaining one that selects
// (`-k`, `-m`, `--deselect`, `--ignore`, a path, `-p no:…`), `testpaths` or `python_files` or
// `python_classes` or `python_functions` or `norecursedirs` or `collect_ignore` changing, `markers`
// aside, and `fail_under` dropping or disappearing. Other edits only report.
const SELECTING_SETTINGS = [
  "testpaths",
  "python_files",
  "python_classes",
  "python_functions",
  "norecursedirs",
  "collect_ignore",
  "collect_ignore_glob",
  "minversion",
  "required_plugins",
];
const pytestOptions = (value: unknown) => {
  const tool = fields(fields(value).tool);
  const pytest = fields(tool.pytest);
  // pytest 9 reads `[tool.pytest]` natively; earlier versions read `[tool.pytest.ini_options]`.
  return {
    ...fields(pytest.ini_options),
    ...Object.fromEntries(Object.entries(pytest).filter(([key]) => key !== "ini_options")),
  };
};
const words = (value: unknown) =>
  optionWords(
    Array.isArray(value) ? value.map(String).join(" ") : typeof value === "string" ? value : "",
  );
const minimum = (value: unknown) => {
  const report = fields(fields(fields(fields(value).tool).coverage).report);
  const setting = report.fail_under;
  return typeof setting === "number" ? setting : typeof setting === "string" ? Number(setting) : 0;
};
function narrowedSettings(before: unknown, after: unknown): string[] {
  const was = pytestOptions(before);
  const now = pytestOptions(after);
  const found: string[] = [];
  for (const key of SELECTING_SETTINGS) {
    if (JSON.stringify(was[key] ?? null) !== JSON.stringify(now[key] ?? null)) found.push(key);
  }
  const oldOptions = words(was.addopts);
  const newOptions = words(now.addopts);
  const kept = new Set(newOptions);
  const known = new Set(oldOptions);
  const dropped = oldOptions.some((word) => !kept.has(word) && !REPORT_OPTION.test(word));
  const narrowing = newOptions.some(
    (word) => !known.has(word) && !REPORT_OPTION.test(word) && !COVERAGE_OPTION.test(word),
  );
  if (dropped || narrowing) found.push("addopts");
  const lowered = minimum(after) < minimum(before) || Number.isNaN(minimum(after));
  if (lowered) found.push("coverage fail_under");
  return found;
}

// A package script by name: `bun run x` and `npm run x` run the script `x`, and `npm test`,
// `pnpm test`, and `yarn test` run `test`. `bun test` is Bun's test runner, not the `test` script,
// so it stays as written. `uv run`'s flags choose how the environment is prepared, not what the tool
// runs, so `uv run --frozen pytest` runs the same command as `uv run pytest`.
function normalize(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:bun|npm|pnpm|yarn) run /, "")
    .replace(/^(?:npm|pnpm|yarn) test$/, "test")
    .replace(
      /\buv run (?:--(?:frozen|locked|no-sync|offline|quiet|no-progress|active)\s+|-q\s+)+/g,
      "uv run ",
    );
}

// Pytest options that add reports without choosing which tests run or whether a failure fails:
// coverage reports, verbosity, and traceback style. A command that only adds them, or trades one for
// another, still runs the same tests. `--cov` and `--cov-fail-under` are not report options, since
// coverage with a threshold can fail the run.
const REPORT_OPTION =
  /^(?:--cov-report(?:=\S+)?|--tb=\S+|-v+|-q+|--verbose|--quiet|-r\w+|--durations=\d+|--junitxml=\S+)$/;
// Report options whose value may follow as the next word (`--cov-report term-missing`); the two are
// read as one word, `--cov-report=term-missing`, so changing the format stays a report change.
const SEPARATE_VALUE = /^(?:--cov-report|--tb|--durations|--junitxml)$/;
const optionWords = (text: string) => {
  const words = text.split(/\s+/).filter(Boolean);
  const joined: string[] = [];
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? "";
    const next = words[at + 1];
    if (SEPARATE_VALUE.test(word) && next !== undefined && !next.startsWith("-")) {
      joined.push(`${word}=${next}`);
      at++;
    } else joined.push(word);
  }
  return joined;
};
// Whether `after` runs everything `before` did: the same command, or the same pytest command with
// report options changed or coverage added. The program (everything through `pytest`) must match,
// every other word of `before` must remain, and `after` may add only coverage options. So adding a
// path or `-k`, which narrows the run, or dropping `--cov`, still blocks.
const PYTEST_PROGRAM = /^(.*?\bpytest)(?: |$)/;
// Options that measure more, which a command may add: `--cov`, `--cov-branch` (which also counts
// branches, so it changes the percentage a threshold checks), and a first `--cov-fail-under`.
// Dropping any of them blocks.
const COVERAGE_OPTION = /^--cov(?:=\S+)?$|^--cov-branch$|^--cov-fail-under=\d+(?:\.\d+)?$/;
function stillRuns(before: string, after: string): boolean {
  const a = normalize(before);
  const b = normalize(after);
  if (a === b) return true;
  const was = PYTEST_PROGRAM.exec(a);
  const now = PYTEST_PROGRAM.exec(b);
  if (!was || !now || was[1] !== now[1]) return false;
  const selecting = (command: string, program: string) =>
    optionWords(command.slice(program.length)).filter((word) => !REPORT_OPTION.test(word));
  const old = selecting(a, was[1] ?? "");
  const added = [...selecting(b, now[1] ?? "")];
  for (const word of old) {
    const at = added.indexOf(word);
    if (at === -1) return false;
    added.splice(at, 1);
  }
  // A threshold may be added only where none was set; a second one could lower it.
  const threshold = (word: string) => word.startsWith("--cov-fail-under");
  if (old.some(threshold) && added.some(threshold)) return false;
  return added.every((word) => COVERAGE_OPTION.test(word));
}
const runsAll = (before: string[], after: string[]) =>
  before.every((command) => after.some((next) => stillRuns(command, next)));

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

// Environment variables that change which tests a runner collects, which plugins it loads, or
// where it reads its settings: `PYTEST_ADDOPTS`, `PYTEST_PLUGINS`, `PYTEST_DISABLE_PLUGIN_AUTOLOAD`,
// coverage's `COVERAGE_*`, and Python's own `PYTHON*` (such as `PYTHONPATH`). Their effective values
// for a step (workflow, then job, then step `env`) are part of its scope, so changing one means the
// step no longer runs what it did. An `env` that is not a mapping is compared whole.
const RUNNER_ENVIRONMENT = /^(?:PYTEST_\w*|COVERAGE_\w*|PYTHON\w*)$/;
function runnerEnvironment(...levels: unknown[]): string {
  const effective = new Map<string, string>();
  for (const level of levels) {
    const env = fields(level).env;
    if (env === undefined) continue;
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      effective.set("*", scalar(env));
      continue;
    }
    for (const [name, value] of Object.entries(env)) {
      if (RUNNER_ENVIRONMENT.test(name)) effective.set(name, scalar(value));
    }
  }
  return JSON.stringify([...effective].sort(([a], [b]) => a.localeCompare(b)));
}

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
        runnerEnvironment(root, job, step),
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
      const ran = after
        .filter((c) => c.scope === scope && asBroad(c.triggers, triggers))
        .flatMap((c) => expand(c.command, known));
      const name = normalize(command);
      const body = known.get(name);
      const covered = runsAll([name], ran) || (body !== undefined && runsAll(segments(body), ran));
      return !covered;
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
    if (PYPROJECT.test(path) || PYPROJECT.test(file.from)) {
      const versions = head.pyprojects?.get(path);
      if (!versions) throw new Error(`the contents of ${path} were not supplied`);
      const narrowed = narrowedSettings(versions.before, versions.after);
      if (narrowed.length > 0) {
        add("gate-weakened", path, `pytest or coverage settings narrowed: ${narrowed.join(", ")}`);
      } else if (testSettings(versions.before) !== testSettings(versions.after)) {
        add("gate-edited", path, "pytest or coverage settings changed");
      }
    }
    if (TASK_RUNNER.test(path) || TASK_RUNNER.test(file.from)) {
      const versions = head.taskFiles?.get(path);
      if (!versions) throw new Error(`the contents of ${path} were not supplied`);
      const weakened = weakenedRecipes(versions);
      for (const name of weakened) {
        add("gate-weakened", path, `the "${name}" recipe no longer runs everything it did`);
      }
      if (weakened.length === 0 && edited) add("gate-edited", path, "task runner file changed");
    }
    if (/(^|\/)package\.json$/.test(path)) {
      for (const name of weakenedScripts(file)) {
        add("gate-weakened", path, `the "${name}" script no longer runs everything it did`);
      }
    }
  }
  return findings;
}
