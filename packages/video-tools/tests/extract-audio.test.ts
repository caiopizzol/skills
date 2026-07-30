import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/index.ts";
import { FFMPEG_COMMAND, extractAudio, parseProbeOutput } from "../src/index.ts";
import {
  ARTIFACTS_DIRECTORY,
  CWD,
  INPUT_PATH,
  PARENT_SHA256,
  fakeExec,
  fakeOutputs,
  failed,
  missingBinary,
  ok,
  readProbeFixture,
} from "./fixtures/video-scenarios.ts";

const probe = parseProbeOutput(readProbeFixture("mp4"));
const silentProbe = parseProbeOutput(
  JSON.stringify({
    format: { format_name: "mp4", duration: "6.000000" },
    streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 640, height: 360 }],
  }),
);

function options(overrides: Partial<Parameters<typeof extractAudio>[0]> = {}) {
  return {
    inputPath: INPUT_PATH,
    parentSha256: PARENT_SHA256,
    artifactsDirectory: ARTIFACTS_DIRECTORY,
    probe,
    cwd: CWD,
    ...overrides,
  };
}

describe("extractAudio", () => {
  it("builds an ffmpeg argv that writes a mono 16 kHz WAV derivative", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    const result = await extractAudio(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "ok", operation: "extract-audio" });
    expect(boundary.requests).toHaveLength(1);
    expect(boundary.requests[0]?.command).toBe(FFMPEG_COMMAND);
    expect(boundary.requests[0]?.args).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      INPUT_PATH,
      "-vn",
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-acodec",
      "pcm_s16le",
      "-f",
      "wav",
      `${ARTIFACTS_DIRECTORY}/audio.wav`,
    ]);
  });

  it("records the derivative with its bytes, hash, operation, and parent hash", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs(128);

    const result = await extractAudio(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({
      outcome: "ok",
      derivative: {
        path: `${ARTIFACTS_DIRECTORY}/audio.wav`,
        bytes: 128,
        operation: "extract-audio",
        parentSha256: PARENT_SHA256,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it("refuses to record a derivative without a parent hash", async () => {
    const boundary = fakeExec(() => ok());

    await expect(extractAudio(options({ parentSha256: "", exec: boundary.exec, ...fakeOutputs() }))).rejects.toThrow(
      /parent SHA-256/,
    );
    expect(boundary.requests).toHaveLength(0);
  });

  it("does not attempt extraction when the probe reports no audio stream", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    const result = await extractAudio(options({ probe: silentProbe, exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "unsupported-input", operation: "extract-audio" });
    expect(boundary.requests).toHaveLength(0);
    expect(outputs.prepared).toEqual([]);
  });

  it("classifies a missing ffmpeg binary as tool-unavailable and discards any partial output", async () => {
    const boundary = fakeExec(() => {
      throw missingBinary(FFMPEG_COMMAND);
    });
    const outputs = fakeOutputs();

    const result = await extractAudio(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "tool-unavailable" });
    expect(result).not.toHaveProperty("derivative");
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/audio.wav`]);
  });

  it("classifies a non-zero exit as extract-failed", async () => {
    const boundary = fakeExec(() => failed("Stream map '0:a:0' matches no streams"));
    const outputs = fakeOutputs();

    const result = await extractAudio(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "extract-failed", message: expect.stringContaining("matches no streams") });
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/audio.wav`]);
  });

  it("classifies an exceeded deadline as timeout and discards partial output", async () => {
    const boundary = fakeExec(
      async () =>
        // A real boundary kills the process on its own deadline and then settles. Never
        // settling would not exercise the wait that stops cleanup racing a live writer.
        new Promise<ExecResult>((settle) => {
          setTimeout(() => settle({ exitCode: 143, stdout: "", stderr: "killed" }), 40);
        }),
    );
    const outputs = fakeOutputs();

    const result = await extractAudio(options({ timeoutMs: 5, exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "timeout" });
    expect(result).not.toHaveProperty("derivative");
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/audio.wav`]);
  });

  it("classifies an empty output file as extract-failed rather than a complete derivative", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs(0);

    const result = await extractAudio(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "extract-failed", message: expect.stringContaining("empty file") });
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/audio.wav`]);
  });
});
