// Usage: bun cli.ts <base> <head> [repo-dir]
// Reads the change from base to head with git only; it never runs code from either commit.
// Prints each finding as a JSON line and writes a Markdown summary to $GITHUB_STEP_SUMMARY when set.
// Exits 0 when the change passes, 1 when a blocking finding lacks the exception label, and 2 on any
// error (fail closed). The label is signalled with TESTS_CHANGED_OK=true.
import { decide, EXCEPTION_LABEL } from "./decide.ts";
import { detect, parseDiff, WORKFLOW, type WorkflowVersions } from "./detect.ts";
import { decidePrior, formatRecord, type PriorRuns, RECORD_TITLE } from "./prior.ts";

const MAX_FILE_BYTES = 256 * 1024;

function fail(message: string): never {
  console.error(`test-integrity: ${message}`);
  process.exit(2);
}

const [base, head, dir = "."] = process.argv.slice(2);
if (!base || !head) fail("usage: bun cli.ts <base> <head> [repo-dir]");

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (result.exitCode !== 0) fail(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

// A file's text at a commit, or undefined when the commit does not have it. Files over the size
// limit are refused rather than read.
function read(commit: string, path: string): string | undefined {
  const entry = /^\d+ blob [0-9a-f]+\s+(\d+)\t/.exec(git("ls-tree", "-l", commit, "--", path));
  if (!entry) return undefined;
  if (Number(entry[1]) > MAX_FILE_BYTES) fail(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
  return git("show", `${commit}:${path}`);
}

// A missing file parses to null, like YAML's empty document.
function parse(text: string | undefined, path: string, as: (text: string) => unknown): unknown {
  if (text === undefined) return null;
  try {
    return as(text);
  } catch {
    return fail(`${path} could not be parsed`);
  }
}

// Every verdict leaves a record on its own run, as a notice annotation, so a later run of this
// workflow on the same pull request, base, head, and detector version can reuse it (see prior.ts).
const pr = Number(process.env.PR_NUMBER);
const version = process.env.TEST_INTEGRITY_VERSION;

async function finish(pass: boolean, summary: string): Promise<never> {
  if (Number.isInteger(pr) && pr > 0 && version) {
    console.log(
      `::notice title=${RECORD_TITLE}::${formatRecord({ pr, base, head, version }, pass)}`,
    );
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) await Bun.write(summaryFile, summary);
  else console.error(summary);
  process.exit(pass ? 0 : 1);
}

// On events that cannot change the verdict, reuse the newest matching verdict instead of
// evaluating again, so an approval survives a title edit or an unrelated label.
async function reusePrior(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const runsFile = process.env.TEST_INTEGRITY_PRIOR_RUNS;
  const runId = Number(process.env.GITHUB_RUN_ID);
  if (!eventPath || !runsFile || !version || !Number.isInteger(pr) || !Number.isInteger(runId))
    return;
  const payload = JSON.parse(await Bun.file(eventPath).text());
  const event = {
    action: String(payload.action ?? ""),
    label: typeof payload.label?.name === "string" ? payload.label.name : undefined,
    baseChanged: payload.changes?.base?.ref?.from !== undefined,
  };
  const prior = JSON.parse(await Bun.file(runsFile).text()) as PriorRuns;
  const decision = decidePrior(event, EXCEPTION_LABEL, { pr, base, head, version, runId }, prior);
  if (decision.kind === "evaluate") return;
  await finish(
    decision.pass,
    `## Test integrity\n\nThis \`${event.action}\` event does not change what is checked, so the verdict of run ${decision.runId} on this base and head stands: ${decision.pass ? "pass" : "fail"}.\n`,
  );
}

try {
  await reusePrior();
  // The root package's scripts at the head commit, where workflow steps run by default, so a step
  // that names a script can be matched to the commands it runs.
  const scripts = new Map<string, string>();
  const manifest = parse(read(head, "package.json"), "package.json", JSON.parse);
  const declared =
    manifest !== null && typeof manifest === "object" && "scripts" in manifest
      ? manifest.scripts
      : undefined;
  if (declared && typeof declared === "object") {
    for (const [name, command] of Object.entries(declared)) {
      if (typeof command === "string") scripts.set(name, command);
    }
  }

  // Git's usual rename detection, so a file moved with small edits reads as a move, not a deletion
  // plus an addition. The detector reads each rename's old and new path and reports a test that
  // moves out of the test patterns.
  const diff = git(
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--no-textconv",
    `${base}...${head}`,
  );

  // Each changed workflow in full, before and after, so the detector can tell which job and step
  // every gate command belongs to. A path outside `.github/workflows/` is not a workflow GitHub
  // runs, so a workflow moved out of it reads as deleted, and one moved in as new.
  const mergeBase = git("merge-base", base, head).trim();
  const workflows = new Map<string, WorkflowVersions>();
  const workflowAt = (commit: string, path: string) =>
    WORKFLOW.test(path) ? parse(read(commit, path), path, Bun.YAML.parse) : null;
  for (const file of parseDiff(diff)) {
    if (!WORKFLOW.test(file.path) && !WORKFLOW.test(file.from)) continue;
    workflows.set(file.path, {
      before: workflowAt(mergeBase, file.from),
      after: workflowAt(head, file.path),
    });
  }

  const findings = detect(diff, { scripts, workflows });
  const verdict = decide(findings, process.env.TESTS_CHANGED_OK === "true");
  for (const finding of findings) console.log(JSON.stringify(finding));
  await finish(verdict.pass, `## Test integrity\n\n${verdict.summary}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
