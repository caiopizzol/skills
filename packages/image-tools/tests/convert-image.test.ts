import { describe, expect, it } from "vite-plus/test";
import type { ExecResult } from "../src/index.ts";
import { MAGICK_COMMAND, convertImage } from "../src/index.ts";
import {
  ARTIFACTS_DIRECTORY,
  CWD,
  PARENT_SHA256,
  fakeExec,
  fakeOutputs,
  failed,
  missingBinary,
  ok,
} from "./fixtures/image-scenarios.ts";

const AVIF_PATH = "/fixture/run/originals/fixture-avif.avif";

function options(overrides: Partial<Parameters<typeof convertImage>[0]> = {}) {
  return {
    inputPath: AVIF_PATH,
    parentSha256: PARENT_SHA256,
    artifactsDirectory: ARTIFACTS_DIRECTORY,
    cwd: CWD,
    ...overrides,
  };
}

describe("convertImage", () => {
  it("builds a magick argv that writes one PNG derivative and names the output coder", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    const result = await convertImage(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "ok", operation: "convert" });
    expect(boundary.requests).toHaveLength(1);
    expect(boundary.requests[0]?.command).toBe(MAGICK_COMMAND);
    expect(boundary.requests[0]?.args).toEqual([
      "-quiet",
      AVIF_PATH,
      "-delete",
      "1--1",
      `png:${ARTIFACTS_DIRECTORY}/converted.png`,
    ]);
  });

  it("records the derivative with its bytes, hash, operation, and parent hash", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs(128);

    const result = await convertImage(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({
      outcome: "ok",
      derivative: {
        path: `${ARTIFACTS_DIRECTORY}/converted.png`,
        bytes: 128,
        operation: "convert",
        parentSha256: PARENT_SHA256,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("refuses to record a derivative without a parent hash", async () => {
    const boundary = fakeExec(() => ok());

    await expect(
      convertImage(options({ parentSha256: "", exec: boundary.exec, ...fakeOutputs() })),
    ).rejects.toThrow(/parent SHA-256/);
    expect(boundary.requests).toHaveLength(0);
  });

  it("classifies a missing magick binary as tool-unavailable and discards any partial output", async () => {
    const boundary = fakeExec(() => {
      throw missingBinary(MAGICK_COMMAND);
    });
    const outputs = fakeOutputs();

    const result = await convertImage(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "tool-unavailable" });
    expect(result).not.toHaveProperty("derivative");
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/converted.png`]);
  });

  it("classifies a shell-style 127 exit as tool-unavailable rather than a convert failure", async () => {
    const boundary = fakeExec(() => failed("magick: command not found", 127));

    const result = await convertImage(options({ exec: boundary.exec, ...fakeOutputs() }));

    expect(result.outcome).toBe("tool-unavailable");
  });

  it("classifies a non-zero exit as convert-failed", async () => {
    const boundary = fakeExec(() => failed("unable to open image"));
    const outputs = fakeOutputs();

    const result = await convertImage(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({
      outcome: "convert-failed",
      message: expect.stringContaining("unable to open image"),
    });
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/converted.png`]);
  });

  it("classifies a missing decode delegate as unsupported-input rather than a failure", async () => {
    const boundary = fakeExec(() =>
      failed("magick: no decode delegate for this image format `HEIC'"),
    );

    const result = await convertImage(options({ exec: boundary.exec, ...fakeOutputs() }));

    expect(result.outcome).toBe("unsupported-input");
  });

  it("classifies an exceeded deadline as timeout and discards partial output", async () => {
    const boundary = fakeExec(
      async () =>
        // A real boundary kills the process on its own deadline and then settles. Never settling
        // would not exercise the wait that stops cleanup racing a live writer.
        new Promise<ExecResult>((settle) => {
          setTimeout(() => settle({ exitCode: 143, stdout: "", stderr: "killed" }), 40);
        }),
    );
    const outputs = fakeOutputs();

    const result = await convertImage(options({ timeoutMs: 5, exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "timeout" });
    expect(result).not.toHaveProperty("derivative");
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/converted.png`]);
  });

  it("classifies an empty output file as convert-failed rather than a complete derivative", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs(0);

    const result = await convertImage(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({
      outcome: "convert-failed",
      message: expect.stringContaining("empty file"),
    });
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/converted.png`]);
  });
});
