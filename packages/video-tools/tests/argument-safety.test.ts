import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExtractAudioArgs,
  buildExtractFrameArgs,
  buildProbeArgs,
  extractAudio,
  extractFrames,
  parseProbeOutput,
  probeVideo,
  resolveWriteTarget,
  type ExecRequest,
} from "../src/index.ts";
import {
  ARTIFACTS_DIRECTORY,
  CWD,
  PARENT_SHA256,
  fakeExec,
  fakeOutputs,
  ok,
  readProbeFixture,
} from "./fixtures/video-scenarios.ts";

// A filename that starts like an option, carries spaces, and carries a quote. If any of these ever
// reached a shell, or were concatenated into one argument, this vector would change shape.
const HOSTILE_NAME = "--output-file 'rm -rf .';$(id) \"quoted\".mp4";
const HOSTILE_PATH = `${CWD}/originals/${HOSTILE_NAME}`;
const probe = parseProbeOutput(readProbeFixture("mp4"));

function argumentAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

describe("argument vector safety", () => {
  it("keeps a hostile filename as exactly one ffprobe argument behind -i", () => {
    const args = buildProbeArgs(HOSTILE_PATH);

    expect(args.filter((argument) => argument === HOSTILE_PATH)).toHaveLength(1);
    expect(argumentAfter(args, "-i")).toBe(HOSTILE_PATH);
    expect(args.every((argument) => typeof argument === "string")).toBe(true);
  });

  it("keeps a hostile filename as exactly one ffmpeg argument in both extract operations", () => {
    const audioArgs = buildExtractAudioArgs(HOSTILE_PATH, `${ARTIFACTS_DIRECTORY}/audio.wav`);
    const frameArgs = buildExtractFrameArgs(HOSTILE_PATH, `${ARTIFACTS_DIRECTORY}/frames/frame-001-0_000s.png`, 0);

    expect(argumentAfter(audioArgs, "-i")).toBe(HOSTILE_PATH);
    expect(argumentAfter(frameArgs, "-i")).toBe(HOSTILE_PATH);
    expect(audioArgs.filter((argument) => argument.includes("$(id)"))).toEqual([HOSTILE_PATH]);
    expect(frameArgs.filter((argument) => argument.includes("$(id)"))).toEqual([HOSTILE_PATH]);
  });

  it("passes the hostile filename through the boundary as argv with no shell involved", async () => {
    const requests: ExecRequest[] = [];
    const boundary = fakeExec((request) => {
      requests.push(request);
      return ok(readProbeFixture("mp4"));
    });

    await probeVideo({ inputPath: HOSTILE_PATH, cwd: CWD, exec: boundary.exec });

    const request = requests[0];
    if (!request) throw new Error("expected one exec request");
    expect(request.command).toBe("ffprobe");
    expect(request.args).toContain(HOSTILE_PATH);
    expect(request.args.some((argument) => argument !== HOSTILE_PATH && /[;$'"]/.test(argument))).toBe(false);
    expect(request).not.toHaveProperty("shell");
  });
});

describe("original preservation", () => {
  it("never targets the input path for writing during audio extraction", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    await extractAudio({
      inputPath: HOSTILE_PATH,
      parentSha256: PARENT_SHA256,
      artifactsDirectory: ARTIFACTS_DIRECTORY,
      probe,
      cwd: CWD,
      exec: boundary.exec,
      ...outputs,
    });

    const outputPath = boundary.requests[0]?.args.at(-1);
    expect(outputPath).toBe(`${ARTIFACTS_DIRECTORY}/audio.wav`);
    expect(outputPath).not.toBe(HOSTILE_PATH);
    expect(outputs.prepared).not.toContain(HOSTILE_PATH);
  });

  it("never targets the input path for writing during frame extraction", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    await extractFrames({
      inputPath: HOSTILE_PATH,
      parentSha256: PARENT_SHA256,
      artifactsDirectory: ARTIFACTS_DIRECTORY,
      durationSeconds: 6,
      frameCount: 3,
      cwd: CWD,
      exec: boundary.exec,
      ...outputs,
    });

    const outputPaths = boundary.requests.map((request) => request.args.at(-1));
    expect(outputPaths.every((path) => path?.startsWith(`${ARTIFACTS_DIRECTORY}/frames/`) === true)).toBe(true);
    expect(outputPaths).not.toContain(HOSTILE_PATH);
    expect(outputs.prepared).not.toContain(HOSTILE_PATH);
    expect(outputs.read).not.toContain(HOSTILE_PATH);
  });

  it("rejects a derivative path that escapes the artifacts directory or lands on the original", () => {
    expect(() =>
      resolveWriteTarget({
        inputPath: HOSTILE_PATH,
        artifactsDirectory: ARTIFACTS_DIRECTORY,
        relativePath: "../originals/overwrite.wav",
        cwd: CWD,
      }),
    ).toThrow(/beneath the artifacts directory/);
    expect(() =>
      resolveWriteTarget({
        inputPath: `${ARTIFACTS_DIRECTORY}/audio.wav`,
        artifactsDirectory: ARTIFACTS_DIRECTORY,
        relativePath: "audio.wav",
        cwd: CWD,
      }),
    ).toThrow(/never be written onto the original/);
  });

  it("rejects a destination that reaches the original through a symlinked artifacts ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "video-tools-symlink-"));
    try {
      const originals = join(root, "originals");
      const artifacts = join(root, "artifacts");
      mkdirSync(originals);
      mkdirSync(artifacts);
      const original = join(originals, "clip.mp4");
      writeFileSync(original, "original bytes");
      // The derivative path stays lexically inside the artifacts directory, so only resolving the
      // link reveals that it lands on the original.
      symlinkSync(originals, join(artifacts, "alias"));

      expect(() =>
        resolveWriteTarget({
          inputPath: original,
          artifactsDirectory: artifacts,
          relativePath: "alias/clip.mp4",
          cwd: root,
        }),
      ).toThrow(/never be written onto the original/);
      expect(readFileSync(original, "utf8")).toBe("original bytes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
