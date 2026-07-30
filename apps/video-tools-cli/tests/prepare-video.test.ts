import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecBoundary, ExecRequest } from "@caiopizzol/media-exec";
import { isComplete, prepareVideo } from "../src/prepare-video.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "video-tools-cli-"));
  directories.push(directory);
  return directory;
}

const PROBE_JSON = JSON.stringify({
  format: { format_name: "mov,mp4", duration: "4.0" },
  streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 16, height: 16 }],
});

function workingExec(onWrite?: () => void): ExecBoundary {
  return async (request) => {
    if (request.args.includes("-version")) return { exitCode: 0, stdout: `${request.command} 7.1\n`, stderr: "" };
    if (request.command === "ffprobe") return { exitCode: 0, stdout: PROBE_JSON, stderr: "" };
    const target = request.args.at(-1);
    if (target !== undefined) await writeFile(target, "frame bytes");
    onWrite?.();
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function missing(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT", syscall: `spawn ${command}` });
}

describe("prepareVideo capability reporting", () => {
  it("creates and reports a temporary artifacts directory when the caller omits one", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "clip.mp4");
    await writeFile(inputPath, "video bytes");

    const result = await prepareVideo(
      { command: "prepare", inputPath },
      { cwd: directory, hostExec: workingExec() },
    );
    directories.push(result.artifacts.directory);

    expect(result.artifacts).toMatchObject({ mode: "temporary" });
    expect(result.artifacts.directory).not.toBe(directory);
    expect(result.frames?.outcome).toBe("ok");
    if (result.frames?.outcome !== "ok") throw new Error("expected prepared frames");
    expect(result.frames.frames.map((frame) => relative(result.artifacts.directory, frame.derivative.path).split(sep)[0]))
      .toEqual(["frames", "frames", "frames"]);
  });

  it("reports a caller-provided artifacts directory", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "clip.mp4");
    const artifactsDirectory = join(directory, "artifacts");
    await writeFile(inputPath, "video bytes");

    const result = await prepareVideo(
      { command: "prepare", inputPath, artifactsDirectory },
      { cwd: directory, hostExec: workingExec() },
    );

    expect(result.artifacts).toEqual({ directory: artifactsDirectory, mode: "caller-provided" });
  });

  // The contract the skill documents is a JSON result with a named outcome. An exception is not one,
  // and it leaves the caller distinguishing "no tooling" from "bad arguments" by reading stderr.
  it("reports absent host tooling as a structured capability gap instead of throwing", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "clip.mp4");
    await writeFile(inputPath, "video bytes");

    const result = await prepareVideo(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      { cwd: directory, hostExec: async () => { throw missing("ffprobe"); } },
    );

    expect(result.capabilityGap).toMatchObject({ outcome: "tool-unavailable", stage: "host-tool" });
    expect(result.capability).toBeNull();
    expect(isComplete(result)).toBe(false);
  });

  it("reports an absent docker client without attempting the media tool", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "clip.mp4");
    await writeFile(inputPath, "video bytes");
    const attempted: string[] = [];

    const result = await prepareVideo(
      {
        command: "prepare",
        inputPath,
        artifactsDirectory: join(directory, "artifacts"),
        containerImage: `example@sha256:${"a".repeat(64)}`,
      },
      {
        cwd: directory,
        hostExec: async (request: ExecRequest) => { attempted.push(request.command); return { exitCode: 0, stdout: "", stderr: "" }; },
        dockerExec: async () => { throw missing("docker"); },
      },
    );

    expect(result.capabilityGap).toMatchObject({ outcome: "tool-unavailable", stage: "container-runtime" });
    expect(attempted).toEqual([]);
  });

  // Version strings describe a tool that already worked. A failed query is a metadata gap, so the
  // probe that already succeeded still stands.
  it("keeps a failed version query as a metadata gap rather than a capability failure", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "clip.mp4");
    await writeFile(inputPath, "video bytes");

    const result = await prepareVideo(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      {
        cwd: directory,
        hostExec: async (request) => {
          if (request.args.includes("-version")) return { exitCode: 1, stdout: "", stderr: "unrecognized option" };
          if (request.command === "ffprobe") return { exitCode: 0, stdout: PROBE_JSON, stderr: "" };
          const target = request.args.at(-1);
          if (target !== undefined) await writeFile(target, "frame bytes");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(result.capability?.versions).toBeNull();
    expect(result.capability?.versionGap).toMatchObject({ outcome: "failed", stage: "version-query" });
    expect(result.probe?.outcome).toBe("ok");
    expect(isComplete(result)).toBe(true);
  });
});

describe("prepareVideo audio coverage", () => {
  // Extracting one track of several is a partial reading. Exit 0 on this source would tell a
  // caller the audio lane was fully read when two thirds of it was never opened.
  it("is not complete when the source carries audio streams the run did not read", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "clip.mp4");
    await writeFile(inputPath, "video bytes");
    const multiAudio = JSON.stringify({
      format: { format_name: "mov,mp4", duration: "4.0" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", width: 16, height: 16 },
        { index: 1, codec_type: "audio", codec_name: "aac" },
        { index: 2, codec_type: "audio", codec_name: "aac" },
      ],
    });

    const result = await prepareVideo(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      {
        cwd: directory,
        hostExec: async (request) => {
          if (request.args.includes("-version")) return { exitCode: 0, stdout: `${request.command} 7.1\n`, stderr: "" };
          if (request.command === "ffprobe") return { exitCode: 0, stdout: multiAudio, stderr: "" };
          const target = request.args.at(-1);
          if (target !== undefined) await writeFile(target, "media bytes");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    if (result.audio?.outcome !== "ok") throw new Error("expected an extracted audio lane");
    expect(result.audio.selection.availableStreamIndexes).toEqual([1, 2]);
    expect(result.audio.selection.omittedStreamIndexes).toEqual([2]);
    expect(result.audio.derivative.sourceStreamIndex).toBe(1);
    expect(isComplete(result)).toBe(false);
  });

  it("is complete when the only audio stream was read", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "clip.mp4");
    await writeFile(inputPath, "video bytes");
    const singleAudio = JSON.stringify({
      format: { format_name: "mov,mp4", duration: "4.0" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", width: 16, height: 16 },
        { index: 1, codec_type: "audio", codec_name: "aac" },
      ],
    });

    const result = await prepareVideo(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      {
        cwd: directory,
        hostExec: async (request) => {
          if (request.args.includes("-version")) return { exitCode: 0, stdout: `${request.command} 7.1\n`, stderr: "" };
          if (request.command === "ffprobe") return { exitCode: 0, stdout: singleAudio, stderr: "" };
          const target = request.args.at(-1);
          if (target !== undefined) await writeFile(target, "media bytes");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    if (result.audio?.outcome !== "ok") throw new Error("expected an extracted audio lane");
    expect(result.audio.selection.omittedStreamIndexes).toEqual([]);
    expect(isComplete(result)).toBe(true);
  });
});

describe("prepareVideo source identity", () => {
  it("discards every derivative and reports input-changed when the original moved underneath it", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "clip.mp4");
    await writeFile(inputPath, "video bytes");
    let swapped = false;

    const result = await prepareVideo(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      { cwd: directory, hostExec: workingExec(() => {
          if (swapped) return;
          swapped = true;
          void writeFile(inputPath, "different video bytes entirely");
        }), },
    );

    expect(result.inputChanged).toMatchObject({ outcome: "input-changed", initialSha256: result.file.sha256 });
    expect(result.frames).toBeNull();
    expect(result.audio).toBeNull();
    expect(isComplete(result)).toBe(false);
    // The manifest is empty and the bytes are gone. A file left behind is one an agent can open.
    expect(await readdir(join(directory, "artifacts", "frames")).catch(() => [])).toEqual([]);
  });

  it("completes normally when the original is stable", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "clip.mp4");
    await writeFile(inputPath, "video bytes");

    const result = await prepareVideo(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      { cwd: directory, hostExec: workingExec() },
    );

    expect(result.inputChanged).toBeNull();
    expect(result.frames?.outcome).toBe("ok");
    expect(isComplete(result)).toBe(true);
  });
});
