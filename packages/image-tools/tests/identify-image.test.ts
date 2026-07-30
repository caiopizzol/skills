import { describe, expect, it } from "vite-plus/test";
import type { ExecResult } from "../src/index.ts";
import {
  IDENTIFY_COMMAND,
  buildIdentifyArgs,
  identifyImage,
  parseIdentifyOutput,
} from "../src/index.ts";
import {
  CWD,
  INPUT_PATH,
  fakeExec,
  failed,
  missingBinary,
  ok,
  readImageManifest,
} from "./fixtures/image-scenarios.ts";

const manifest = readImageManifest();

function manifestEntry(filename: string) {
  const entry = manifest.fixtures.find((fixture) => fixture.filename === filename);
  if (!entry) throw new Error(`missing manifest entry: ${filename}`);
  return entry;
}

describe("parseIdentifyOutput", () => {
  it("reads a single-frame raster as one frame with its format and dimensions", () => {
    const identity = parseIdentifyOutput("PNG 640 360\n");

    expect(identity).toEqual({
      formatVersion: 1,
      format: "PNG",
      width: 640,
      height: 360,
      frameCount: 1,
    });
  });

  it("counts one line per frame so an animation reports its real frame count", () => {
    const identity = parseIdentifyOutput("GIF 640 360\nGIF 640 360\nGIF 640 360\n");
    const expected = manifestEntry("fixture-animated.gif");

    expect(identity.format).toBe("GIF");
    expect(identity.frameCount).toBe(expected.frameCount);
  });

  it("rejects malformed and empty output rather than reporting an empty identity", () => {
    expect(() => parseIdentifyOutput("")).toThrow(/no output/);
    expect(() => parseIdentifyOutput("   \n  \n")).toThrow(/no output/);
    expect(() => parseIdentifyOutput("PNG 640\n")).toThrow(/unreadable frame line/);
    expect(() => parseIdentifyOutput("PNG wide tall\n")).toThrow(/unusable dimensions/);
    expect(() => parseIdentifyOutput("PNG 0 360\n")).toThrow(/unusable dimensions/);
  });

  it("rejects a malformed line after the first rather than counting it as a frame", () => {
    expect(() => parseIdentifyOutput("GIF 640 360\nmalformed\n")).toThrow(
      /unreadable frame line: malformed/,
    );
    expect(() => parseIdentifyOutput("GIF 640 360\nGIF 640 tall\n")).toThrow(/unusable dimensions/);
  });
});

describe("identifyImage", () => {
  it("builds an identify argv that pings headers and prints one line per frame", async () => {
    const boundary = fakeExec(() => ok("PNG 640 360\n"));

    const result = await identifyImage({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result).toMatchObject({ outcome: "ok", operation: "identify" });
    expect(boundary.requests).toEqual([
      {
        command: IDENTIFY_COMMAND,
        args: buildIdentifyArgs(INPUT_PATH),
        cwd: CWD,
        timeoutMs: 60_000,
      },
    ]);
    expect(boundary.requests[0]?.args).toEqual([
      "-quiet",
      "-ping",
      "-format",
      "%m %w %h\\n",
      INPUT_PATH,
    ]);
  });

  it("reports the frame count on the identity so GIF routing has it", async () => {
    const boundary = fakeExec(() => ok("GIF 640 360\nGIF 640 360\nGIF 640 360\n"));

    const result = await identifyImage({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    if (result.outcome !== "ok") throw new Error(`expected ok, received ${result.outcome}`);
    expect(result.identity.frameCount).toBe(3);
  });

  it("classifies a missing identify binary as tool-unavailable", async () => {
    const boundary = fakeExec(() => {
      throw missingBinary(IDENTIFY_COMMAND);
    });

    const result = await identifyImage({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("tool-unavailable");
    expect(result).not.toHaveProperty("identity");
  });

  it("classifies a shell-style 127 exit as tool-unavailable rather than an identify failure", async () => {
    const boundary = fakeExec(() => failed("identify: command not found", 127));

    const result = await identifyImage({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("tool-unavailable");
  });

  it("classifies a non-zero exit as identify-failed and keeps the stderr detail", async () => {
    const boundary = fakeExec(() => failed("improper image header"));

    const result = await identifyImage({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result).toMatchObject({
      outcome: "identify-failed",
      message: expect.stringContaining("improper image header"),
    });
  });

  it("classifies a missing decode delegate as unsupported-input rather than a failure", async () => {
    const boundary = fakeExec(() =>
      failed("identify: no decode delegate for this image format `HEIC'"),
    );

    const result = await identifyImage({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("unsupported-input");
  });

  it("classifies malformed output on a clean exit as identify-failed", async () => {
    const boundary = fakeExec(() => ok("PNG six-forty three-sixty\n"));

    const result = await identifyImage({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result).toMatchObject({
      outcome: "identify-failed",
      message: expect.stringContaining("unusable dimensions"),
    });
  });

  it("classifies empty output on a clean exit as identify-failed rather than success", async () => {
    const boundary = fakeExec(() => ok("   "));

    const result = await identifyImage({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result).toMatchObject({
      outcome: "identify-failed",
      message: expect.stringContaining("no output"),
    });
  });

  it("classifies an exceeded deadline as timeout", async () => {
    const boundary = fakeExec(
      async () =>
        // A real boundary kills the process on its own deadline and then settles. Never settling
        // would not exercise the wait that stops cleanup racing a live writer.
        new Promise<ExecResult>((settle) => {
          setTimeout(() => settle({ exitCode: 143, stdout: "", stderr: "killed" }), 40);
        }),
    );

    const result = await identifyImage({
      inputPath: INPUT_PATH,
      cwd: CWD,
      timeoutMs: 5,
      exec: boundary.exec,
    });

    expect(result.outcome).toBe("timeout");
    expect(result).not.toHaveProperty("identity");
  });
});
