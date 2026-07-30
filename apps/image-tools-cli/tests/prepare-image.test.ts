import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecBoundary, ExecRequest } from "@caiopizzol/media-exec";
import { isComplete, prepareImage } from "../src/prepare-image.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "image-tools-cli-"));
  directories.push(directory);
  return directory;
}

const BMP = Buffer.from([0x42, 0x4d, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x1a, 0, 0, 0]);

function missing(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT", syscall: `spawn ${command}` });
}

function workingExec(format: string, onWrite?: () => void): ExecBoundary {
  return async (request) => {
    if (request.args.includes("-version")) return { exitCode: 0, stdout: `${request.command} 7.1\n`, stderr: "" };
    if (request.command === "identify") return { exitCode: 0, stdout: `${format} 10 20\n`, stderr: "" };
    const target = request.args.at(-1);
    if (target !== undefined) await writeFile(target.replace(/^png:/, ""), "converted bytes");
    onWrite?.();
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("prepareImage capability reporting", () => {
  // The skill documents a JSON result with a named outcome. An exception is not one, and it leaves
  // the caller separating "no tooling" from "bad arguments" by reading stderr.
  it("reports absent host tooling as a structured capability gap instead of throwing", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "a.bmp");
    await writeFile(inputPath, BMP);

    const result = await prepareImage(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      { cwd: directory, hostExec: async () => { throw missing("identify"); } },
    );

    expect(result.capabilityGap).toMatchObject({ outcome: "tool-unavailable", stage: "host-tool" });
    expect(isComplete(result)).toBe(false);
  });

  it("reports an absent docker client before attempting the media tool", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "a.bmp");
    await writeFile(inputPath, BMP);
    const attempted: string[] = [];

    const result = await prepareImage(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts"), containerImage: `x@sha256:${"a".repeat(64)}` },
      {
        cwd: directory,
        hostExec: async (request: ExecRequest) => { attempted.push(request.command); return { exitCode: 0, stdout: "", stderr: "" }; },
        dockerExec: async () => { throw missing("docker"); },
      },
    );

    expect(result.capabilityGap).toMatchObject({ outcome: "tool-unavailable", stage: "container-runtime" });
    expect(attempted).toEqual([]);
  });

  // A static image needs only `identify`. Requiring `magick` up front refused readings that work.
  it("reads a static image without requiring the converter to be present", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "a.png");
    await writeFile(inputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const result = await prepareImage(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      {
        cwd: directory,
        hostExec: async (request) => {
          if (request.command === "magick") throw missing("magick");
          if (request.args.includes("-version")) return { exitCode: 0, stdout: "identify 7.1\n", stderr: "" };
          return { exitCode: 0, stdout: "PNG 10 20\n", stderr: "" };
        },
      },
    );

    expect(result.identify?.outcome).toBe("ok");
    expect(result.capability?.versionGap).toMatchObject({ outcome: "tool-unavailable" });
    expect(isComplete(result)).toBe(true);
  });

  // A binary absent from a caller-supplied image is a fact about that image. Reporting it as
  // host-tool sends someone to install software on a machine that is fine.
  it("attributes a tool missing inside a container image to that image", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "a.bmp");
    await writeFile(inputPath, BMP);

    const result = await prepareImage(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts"), containerImage: `x@sha256:${"a".repeat(64)}` },
      {
        cwd: directory,
        dockerExec: async (request) =>
          request.args.includes("inspect")
            ? { exitCode: 0, stdout: `sha256:${"b".repeat(64)}\n`, stderr: "" }
            : { exitCode: 127, stdout: "", stderr: 'exec: "identify": executable file not found in $PATH' },
      },
    );

    expect(result.capabilityGap).toMatchObject({ outcome: "tool-unavailable", stage: "container-tool" });
  });
});

describe("prepareImage source identity", () => {
  it("discards derivatives and reports input-changed when the original moved underneath it", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "a.bmp");
    await writeFile(inputPath, BMP);
    let swapped = false;

    const result = await prepareImage(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      {
        cwd: directory,
        hostExec: workingExec("BMP", () => {
          if (swapped) return;
          swapped = true;
          void writeFile(inputPath, Buffer.concat([BMP, Buffer.from("different")]));
        }),
      },
    );

    expect(result.inputChanged).toMatchObject({ outcome: "input-changed", initialSha256: result.file.sha256 });
    expect(result.derivative).toBeNull();
    expect(isComplete(result)).toBe(false);
    expect(await readdir(join(directory, "artifacts"))).toEqual([]);
  });

  it("routes a BMP through a parent-bound conversion when the original is stable", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "a.bmp");
    await writeFile(inputPath, BMP);

    const result = await prepareImage(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      { cwd: directory, hostExec: workingExec("BMP") },
    );

    expect(isComplete(result)).toBe(true);
    if (result.derivative?.outcome !== "ok" || result.derivative.operation !== "convert") {
      throw new Error("expected a converted derivative");
    }
    expect(result.derivative.derivative.parentSha256).toBe(result.file.sha256);
  });
});
