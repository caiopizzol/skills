import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parseArguments } from "../src/arguments.ts";
import { inspectFile, isComplete } from "../src/inspect-file.ts";

const CLI = resolve(import.meta.dirname, "..", "src", "cli.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// Outside the monorepo on purpose. The package this CLI wraps is a workspace module, so an agent
// holding only an installed skill could not reach it before; running from a temporary directory is
// what proves the command works where the agent actually stands.
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "text-tools-cli-"));
  directories.push(directory);
  return directory;
}

async function runCli(
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Vitest runs under Node, so the process boundary is node:child_process rather than Bun.spawn.
  const { execFile } = await import("node:child_process");
  return new Promise((settle) => {
    execFile(
      "bun",
      [CLI, ...args],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : 0;
        settle({ exitCode: code, stdout, stderr });
      },
    );
  });
}

describe("argument parsing", () => {
  it("reads an exact path and an optional bound", () => {
    expect(parseArguments(["inspect", "notes.json", "--max-characters", "500"])).toEqual({
      command: "inspect",
      inputPath: "notes.json",
      maximumCharacters: 500,
    });
  });

  it("treats no arguments and --help as the same request", () => {
    expect(parseArguments([])).toEqual({ command: "help" });
    expect(parseArguments(["--help"])).toEqual({ command: "help" });
  });

  it("refuses an unknown command, a missing path, and a non-positive bound", () => {
    expect(() => parseArguments(["prepare", "a.txt"])).toThrow(/unknown command/);
    expect(() => parseArguments(["inspect"])).toThrow(/one exact input path/);
    expect(() => parseArguments(["inspect", "a.txt", "--max-characters", "0"])).toThrow(
      /positive integer/,
    );
    expect(() => parseArguments(["inspect", "a.txt", "--bogus", "1"])).toThrow(/unknown option/);
  });
});

describe("running from outside the monorepo", () => {
  it("inspects a complete JSON file and exits 0", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "config.json"), '{"token":"JSON-103","retryable":true}');

    const run = await runCli(["inspect", "config.json"], directory);
    const result = JSON.parse(run.stdout) as {
      outcome: string;
      structure: { kind: string; topLevelKeys: string[] };
    };

    expect(run.exitCode).toBe(0);
    expect(result.outcome).toBe("ok");
    expect(result.structure).toMatchObject({ kind: "json", topLevelKeys: ["retryable", "token"] });
  });

  // Structure failure is a partial result, not an empty one: the decoded text is still evidence.
  it("keeps the decoded text and exits 2 when the declared structure fails", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "broken.json"), "not json at all");

    const run = await runCli(["inspect", "broken.json"], directory);
    const result = JSON.parse(run.stdout) as { outcome: string; sections: Array<{ text: string }> };

    expect(run.exitCode).toBe(2);
    expect(result.outcome).toBe("parse-failed");
    expect(result.sections.map((s) => s.text).join("")).toBe("not json at all");
  });

  it("exits 2 with omitted ranges when the bound truncates the file", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "long.txt"), "x".repeat(500));

    const run = await runCli(["inspect", "long.txt", "--max-characters", "100"], directory);
    const result = JSON.parse(run.stdout) as {
      coverage: { boundedBy: string; omittedRanges: unknown[] };
    };

    expect(run.exitCode).toBe(2);
    expect(result.coverage.boundedBy).toBe("maximum-characters");
    expect(result.coverage.omittedRanges).toHaveLength(1);
  });

  it("exits 1 with no JSON when the input cannot be used", async () => {
    const directory = await temporaryDirectory();

    const run = await runCli(["inspect", "absent.txt"], directory);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Usage:");
  });

  it("refuses a directory rather than reading it as a file", async () => {
    const directory = await temporaryDirectory();

    await expect(inspectFile({ command: "inspect", inputPath: directory })).rejects.toThrow(
      /not a regular file/,
    );
  });
});

describe("completeness", () => {
  it("is false for a bounded reading even when every retained section parsed", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "long.txt");
    await writeFile(inputPath, "y".repeat(300));

    const result = await inspectFile({ command: "inspect", inputPath, maximumCharacters: 50 });

    expect(result.outcome).toBe("ok");
    expect(isComplete(result)).toBe(false);
  });
});
