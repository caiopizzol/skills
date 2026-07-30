import { describe, expect, it } from "vite-plus/test";
import { FFMPEG_COMMAND, extractFrames } from "../src/index.ts";
import {
  ARTIFACTS_DIRECTORY,
  CWD,
  INPUT_PATH,
  PARENT_SHA256,
  delayedResult,
  fakeExec,
  fakeOutputs,
  failed,
  missingBinary,
  ok,
} from "./fixtures/video-scenarios.ts";

function options(overrides: Partial<Parameters<typeof extractFrames>[0]> = {}) {
  return {
    inputPath: INPUT_PATH,
    parentSha256: PARENT_SHA256,
    artifactsDirectory: ARTIFACTS_DIRECTORY,
    durationSeconds: 6,
    frameCount: 3,
    cwd: CWD,
    ...overrides,
  };
}

describe("extractFrames", () => {
  it("builds one ffmpeg argv per sampled frame, each writing a PNG", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    const result = await extractFrames(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "ok", operation: "extract-frames" });
    expect(boundary.requests).toHaveLength(3);
    expect(boundary.requests.every((request) => request.command === FFMPEG_COMMAND)).toBe(true);
    expect(boundary.requests[0]?.args).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      "0.000",
      "-i",
      INPUT_PATH,
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      `${ARTIFACTS_DIRECTORY}/frames/frame-001-0_000s.png`,
    ]);
    expect(boundary.requests.map((request) => request.args.at(-1))).toEqual([
      `${ARTIFACTS_DIRECTORY}/frames/frame-001-0_000s.png`,
      `${ARTIFACTS_DIRECTORY}/frames/frame-002-2_950s.png`,
      `${ARTIFACTS_DIRECTORY}/frames/frame-003-5_900s.png`,
    ]);
  });

  it("records every sampled timestamp with a derivative carrying the parent hash", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs(96);

    const result = await extractFrames(options({ exec: boundary.exec, ...outputs }));

    if (result.outcome !== "ok") throw new Error(`expected ok, received ${result.outcome}`);
    expect(result.frames.map((frame) => frame.timestampSeconds)).toEqual(
      result.sampling.timestampsSeconds,
    );
    expect(result.frames.every((frame) => frame.derivative.parentSha256 === PARENT_SHA256)).toBe(
      true,
    );
    expect(result.frames.every((frame) => frame.derivative.operation === "extract-frames")).toBe(
      true,
    );
    expect(result.frames.every((frame) => frame.derivative.bytes === 96)).toBe(true);
    expect(result.sampling.omittedIntervalsSeconds).toEqual([
      { startSeconds: 0, endSeconds: 2.95 },
      { startSeconds: 2.95, endSeconds: 5.9 },
      { startSeconds: 5.9, endSeconds: 6 },
    ]);
  });

  it("refuses to record a derivative without a parent hash", async () => {
    const boundary = fakeExec(() => ok());

    await expect(
      extractFrames(options({ parentSha256: "not-a-hash", exec: boundary.exec, ...fakeOutputs() })),
    ).rejects.toThrow(/parent SHA-256/);
    expect(boundary.requests).toHaveLength(0);
  });

  it("classifies a missing ffmpeg binary as tool-unavailable and reports no frames", async () => {
    const boundary = fakeExec(() => {
      throw missingBinary(FFMPEG_COMMAND);
    });
    const outputs = fakeOutputs();

    const result = await extractFrames(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "tool-unavailable" });
    expect(result).not.toHaveProperty("frames");
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/frames/frame-001-0_000s.png`]);
  });

  it("classifies a non-zero exit part-way through as extract-failed and discards every frame written so far", async () => {
    let call = 0;
    const boundary = fakeExec(() => {
      call += 1;
      return call === 2 ? failed("Output file is empty") : ok();
    });
    const outputs = fakeOutputs();

    const result = await extractFrames(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({
      outcome: "extract-failed",
      message: expect.stringContaining("2.95s"),
    });
    expect(outputs.discarded).toEqual([
      `${ARTIFACTS_DIRECTORY}/frames/frame-001-0_000s.png`,
      `${ARTIFACTS_DIRECTORY}/frames/frame-002-2_950s.png`,
    ]);
  });

  it("classifies an exceeded deadline as timeout and discards partial frames instead of reporting them", async () => {
    const boundary = fakeExec((request) =>
      request.args.includes("2.950") ? delayedResult(ok(), 500) : ok(),
    );
    const outputs = fakeOutputs();

    const result = await extractFrames(options({ timeoutMs: 40, exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "timeout" });
    expect(result).not.toHaveProperty("frames");
    expect(outputs.discarded).toContain(`${ARTIFACTS_DIRECTORY}/frames/frame-001-0_000s.png`);
  });

  it("classifies an empty frame file as extract-failed", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs(0);

    const result = await extractFrames(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({
      outcome: "extract-failed",
      message: expect.stringContaining("empty file"),
    });
  });

  it("classifies an unusable duration as unsupported-input without running ffmpeg", async () => {
    const boundary = fakeExec(() => ok());

    const result = await extractFrames(
      options({ durationSeconds: 0, exec: boundary.exec, ...fakeOutputs() }),
    );

    expect(result).toMatchObject({ outcome: "unsupported-input" });
    expect(boundary.requests).toHaveLength(0);
  });

  it("honours explicit timestamps and the maximum frame bound", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    const result = await extractFrames(
      options({
        frameCount: undefined,
        timestampsSeconds: [5, 1, 3],
        maxFrames: 2,
        exec: boundary.exec,
        ...outputs,
      }),
    );

    if (result.outcome !== "ok") throw new Error(`expected ok, received ${result.outcome}`);
    expect(result.sampling.timestampsSeconds).toEqual([1, 3]);
    expect(result.sampling.rejectedTimestampsSeconds).toEqual([5]);
    expect(boundary.requests).toHaveLength(2);
  });
});
