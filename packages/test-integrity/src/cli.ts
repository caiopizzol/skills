// Usage: bun cli.ts <base> <head> [repo-dir]
// Reads the change from base to head with git only; it never runs code from either commit.
// Prints each finding as a JSON line and writes a Markdown summary to $GITHUB_STEP_SUMMARY when set.
// Exits 0 when the change passes, 1 when a blocking finding lacks the exception label, and 2 on any
// error (fail closed). The label is signalled with TESTS_CHANGED_OK=true.
import { decide } from "./decide.ts";
import { detect, UnparseableDiff } from "./detect.ts";

const MAX_PACKAGE_JSON_BYTES = 256 * 1024;

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

// Scripts from every package.json at the head commit, so a workflow step that names a script can be
// matched to the commands it runs.
const known = new Map<string, string>();
for (const entry of git("ls-tree", "-r", "-l", "--full-tree", head).split("\n")) {
  const match = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(entry);
  if (!match) continue;
  const [, size = "0", path = ""] = match;
  if (!/(^|\/)package\.json$/.test(path) || path.includes("node_modules/")) continue;
  if (Number(size) > MAX_PACKAGE_JSON_BYTES)
    fail(`${path} is larger than ${MAX_PACKAGE_JSON_BYTES} bytes`);
  let scripts: unknown;
  try {
    scripts = JSON.parse(git("show", `${head}:${path}`)).scripts;
  } catch {
    fail(`${path} at ${head} is not valid JSON`);
  }
  if (scripts && typeof scripts === "object") {
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command === "string" && !known.has(name)) known.set(name, command);
    }
  }
}

// Git's usual rename detection, so a file moved with small edits reads as a move, not a deletion
// plus an addition. The detector reads each rename's old and new path and reports a test that moves
// out of the test patterns.
const diff = git(
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--find-renames",
  "--no-textconv",
  `${base}...${head}`,
);
let findings;
try {
  findings = detect(diff, known);
} catch (error) {
  if (error instanceof UnparseableDiff) fail(error.message);
  throw error;
}

const verdict = decide(findings, process.env.TESTS_CHANGED_OK === "true");
for (const finding of findings) console.log(JSON.stringify(finding));
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) await Bun.write(summaryFile, `## Test integrity\n\n${verdict.summary}\n`);
else console.error(verdict.summary);
process.exit(verdict.pass ? 0 : 1);
