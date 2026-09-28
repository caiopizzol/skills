import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";

const CLI = resolve(import.meta.dirname, "..", "src", "cli.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// A throwaway repository with a base commit and a head commit on top of it.
async function repository(base: Record<string, string>, head: Record<string, string | null>) {
  const dir = await mkdtemp(join(tmpdir(), "test-integrity-cli-"));
  directories.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
    }).trim();
  const commit = async (files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) git("rm", "-q", path);
      else {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), text);
        git("add", path);
      }
    }
    git("commit", "-q", "-m", "change");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  return { dir, base: await commit(base), head: await commit(head) };
}

// Vitest runs under Node, so the process boundary is node:child_process rather than Bun.spawn.
function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((settle) => {
    execFile(
      "bun",
      [CLI, ...args],
      { env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : 0;
        settle({ exitCode: code, stdout, stderr });
      },
    );
  });
}
const rules = (stdout: string) =>
  stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { rule: string }).rule);

const ci = (steps: string) =>
  `on:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;

test("a workflow is read from git in full, so an unchanged step's script can cover a removed one", async () => {
  const pkg = (check: string) => JSON.stringify({ scripts: { check } });
  const repo = await repository(
    {
      "package.json": pkg("biome check && tsc && bun test"),
      ".github/workflows/ci.yml": ci("      - run: bun run check\n      - run: bun test\n"),
    },
    { ".github/workflows/ci.yml": ci("      - run: bun run check\n") },
  );
  const covered = await runCli([repo.base, repo.head, repo.dir]);
  expect({ exitCode: covered.exitCode, rules: rules(covered.stdout) }).toEqual({
    exitCode: 0,
    rules: ["gate-edited"],
  });

  const uncovered = await repository(
    {
      "package.json": pkg("biome check && tsc"),
      ".github/workflows/ci.yml": ci("      - run: bun run check\n      - run: bun test\n"),
    },
    { ".github/workflows/ci.yml": ci("      - run: bun run check\n") },
  );
  const result = await runCli([uncovered.base, uncovered.head, uncovered.dir]);
  expect({ exitCode: result.exitCode, rules: rules(result.stdout) }).toEqual({
    exitCode: 1,
    rules: ["gate-weakened"],
  });
});

test("a deleted workflow is read at the base, and its gate commands count as dropped", async () => {
  const repo = await repository(
    { ".github/workflows/ci.yml": ci("      - run: bun test\n") },
    { ".github/workflows/ci.yml": null },
  );
  const result = await runCli([repo.base, repo.head, repo.dir]);
  expect({ exitCode: result.exitCode, rules: rules(result.stdout) }).toEqual({
    exitCode: 1,
    rules: ["gate-weakened"],
  });
});

test("a workflow that is not valid YAML, or is too large to read, fails closed", async () => {
  const broken = await repository(
    { ".github/workflows/ci.yml": ci("      - run: bun test\n") },
    { ".github/workflows/ci.yml": "jobs: [unclosed\n" },
  );
  const unparsed = await runCli([broken.base, broken.head, broken.dir]);
  expect(unparsed.exitCode).toBe(2);
  expect(unparsed.stderr).toContain(".github/workflows/ci.yml could not be parsed");

  const large = await repository(
    { ".github/workflows/ci.yml": ci("      - run: bun test\n") },
    { ".github/workflows/ci.yml": `${ci("      - run: bun test\n")}#${"x".repeat(300 * 1024)}\n` },
  );
  const oversized = await runCli([large.base, large.head, large.dir]);
  expect(oversized.exitCode).toBe(2);
  expect(oversized.stderr).toContain(".github/workflows/ci.yml is larger than");
});

test("a package.json that is not valid JSON fails closed", async () => {
  const repo = await repository(
    { "package.json": "{}" },
    { "package.json": "{ not json", ".github/workflows/ci.yml": ci("      - run: bun test\n") },
  );
  const result = await runCli([repo.base, repo.head, repo.dir]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("package.json could not be parsed");
});

test("a workflow moved out of .github/workflows counts as deleted", async () => {
  const repo = await repository(
    { ".github/workflows/ci.yml": ci("      - run: bun test\n") },
    { ".github/workflows/ci.yml": null, ".github/disabled/ci.yml": ci("      - run: bun test\n") },
  );
  const result = await runCli([repo.base, repo.head, repo.dir]);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout.trim())).toEqual({
    rule: "gate-weakened",
    severity: "block",
    file: ".github/disabled/ci.yml",
    detail: "workflow with gate commands deleted: bun test",
  });
});
