import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConvertArgs,
  buildExpandGifFrameArgs,
  buildIdentifyArgs,
  convertImage,
  expandGifFrames,
  identifyImage,
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
} from "./fixtures/image-scenarios.ts";

// A filename that starts like an option, carries spaces, and carries a quote. If any of these ever
// reached a shell, or were concatenated into one argument, this vector would change shape.
const HOSTILE_NAME = "--output-file 'rm -rf .';$(id) \"quoted\".png";
const HOSTILE_PATH = `${CWD}/originals/${HOSTILE_NAME}`;

describe("argument vector safety", () => {
  it("keeps a hostile filename as exactly one identify argument", () => {
    const args = buildIdentifyArgs(HOSTILE_PATH);

    expect(args.filter((argument) => argument === HOSTILE_PATH)).toHaveLength(1);
    expect(args.at(-1)).toBe(HOSTILE_PATH);
    expect(args.every((argument) => typeof argument === "string")).toBe(true);
  });

  it("keeps a hostile filename as exactly one magick argument in both write operations", () => {
    const convertArgs = buildConvertArgs(HOSTILE_PATH, `${ARTIFACTS_DIRECTORY}/converted.png`);
    const frameArgs = buildExpandGifFrameArgs(HOSTILE_PATH, `${ARTIFACTS_DIRECTORY}/frames/frame-000.png`, 0);

    expect(convertArgs.filter((argument) => argument === HOSTILE_PATH)).toHaveLength(1);
    expect(frameArgs.filter((argument) => argument === HOSTILE_PATH)).toHaveLength(1);
    expect(convertArgs.filter((argument) => argument.includes("$(id)"))).toEqual([HOSTILE_PATH]);
    expect(frameArgs.filter((argument) => argument.includes("$(id)"))).toEqual([HOSTILE_PATH]);
  });

  it("passes the hostile filename through the boundary as argv with no shell involved", async () => {
    const requests: ExecRequest[] = [];
    const boundary = fakeExec((request) => {
      requests.push(request);
      return ok("PNG 640 360\n");
    });

    await identifyImage({ inputPath: HOSTILE_PATH, cwd: CWD, exec: boundary.exec });

    const request = requests[0];
    if (!request) throw new Error("expected one exec request");
    expect(request.command).toBe("identify");
    expect(request.args).toContain(HOSTILE_PATH);
    expect(request.args.some((argument) => argument !== HOSTILE_PATH && /[;$'"]/.test(argument))).toBe(false);
    expect(request).not.toHaveProperty("shell");
  });

  it("resolves the input to an absolute path so a leading hyphen cannot be read as an option", async () => {
    const boundary = fakeExec(() => ok("PNG 640 360\n"));

    await identifyImage({ inputPath: HOSTILE_NAME, cwd: `${CWD}/originals`, exec: boundary.exec });

    expect(boundary.requests[0]?.args.at(-1)).toBe(HOSTILE_PATH);
    expect(boundary.requests[0]?.args.at(-1)?.startsWith("-")).toBe(false);
  });
});

describe("original preservation", () => {
  it("never targets the input path for writing during conversion", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    await convertImage({
      inputPath: HOSTILE_PATH,
      parentSha256: PARENT_SHA256,
      artifactsDirectory: ARTIFACTS_DIRECTORY,
      cwd: CWD,
      exec: boundary.exec,
      ...outputs,
    });

    const outputPath = boundary.requests[0]?.args.at(-1);
    expect(outputPath).toBe(`png:${ARTIFACTS_DIRECTORY}/converted.png`);
    expect(outputPath).not.toBe(HOSTILE_PATH);
    expect(outputs.prepared).not.toContain(HOSTILE_PATH);
    expect(outputs.read).not.toContain(HOSTILE_PATH);
  });

  it("never targets the input path for writing during gif expansion", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    await expandGifFrames({
      inputPath: HOSTILE_PATH,
      parentSha256: PARENT_SHA256,
      artifactsDirectory: ARTIFACTS_DIRECTORY,
      frameCount: 3,
      cwd: CWD,
      exec: boundary.exec,
      ...outputs,
    });

    const outputPaths = boundary.requests.map((request) => request.args.at(-1));
    expect(outputPaths.every((path) => path?.startsWith(`png:${ARTIFACTS_DIRECTORY}/frames/`) === true)).toBe(true);
    expect(outputPaths).not.toContain(HOSTILE_PATH);
    expect(outputs.prepared).not.toContain(HOSTILE_PATH);
    expect(outputs.read).not.toContain(HOSTILE_PATH);
  });

  it("rejects a derivative path that escapes the artifacts directory or lands on the original", () => {
    expect(() =>
      resolveWriteTarget({
        inputPath: HOSTILE_PATH,
        artifactsDirectory: ARTIFACTS_DIRECTORY,
        relativePath: "../originals/overwrite.png",
        cwd: CWD,
      }),
    ).toThrow(/beneath the artifacts directory/);
    expect(() =>
      resolveWriteTarget({
        inputPath: `${ARTIFACTS_DIRECTORY}/converted.png`,
        artifactsDirectory: ARTIFACTS_DIRECTORY,
        relativePath: "converted.png",
        cwd: CWD,
      }),
    ).toThrow(/never be written onto the original/);
  });

  it("rejects a destination that reaches the original through a symlinked artifacts ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "image-tools-symlink-"));
    try {
      const originals = join(root, "originals");
      const artifacts = join(root, "artifacts");
      mkdirSync(originals);
      mkdirSync(artifacts);
      const original = join(originals, "shot.png");
      writeFileSync(original, "original bytes");
      // The derivative path stays lexically inside the artifacts directory, so only resolving the
      // link reveals that it lands on the original.
      symlinkSync(originals, join(artifacts, "alias"));

      expect(() =>
        resolveWriteTarget({
          inputPath: original,
          artifactsDirectory: artifacts,
          relativePath: "alias/shot.png",
          cwd: root,
        }),
      ).toThrow(/never be written onto the original/);
      expect(readFileSync(original, "utf8")).toBe("original bytes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
