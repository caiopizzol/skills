import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MAX_GIF_FRAMES,
  MAGICK_COMMAND,
  expandGifFrames,
  planGifFrames,
} from "../src/index.ts";
import {
  ARTIFACTS_DIRECTORY,
  CWD,
  PARENT_SHA256,
  delayedResult,
  fakeExec,
  fakeOutputs,
  failed,
  missingBinary,
  ok,
} from "./fixtures/image-scenarios.ts";

const GIF_PATH = "/fixture/run/originals/fixture-animated.gif";

function options(overrides: Partial<Parameters<typeof expandGifFrames>[0]> = {}) {
  return {
    inputPath: GIF_PATH,
    parentSha256: PARENT_SHA256,
    artifactsDirectory: ARTIFACTS_DIRECTORY,
    frameCount: 3,
    cwd: CWD,
    ...overrides,
  };
}

describe("planGifFrames", () => {
  it("selects every frame when the animation fits inside the bound", () => {
    expect(planGifFrames(3)).toEqual({
      frameCount: 3,
      maxFrames: DEFAULT_MAX_GIF_FRAMES,
      boundedBy: "frame-count",
      selectedIndexes: [0, 1, 2],
      omittedIndexes: [],
    });
  });

  it("samples deterministically across a longer animation, covering the first and last frames", () => {
    const plan = planGifFrames(30, 5);

    expect(plan).toEqual(planGifFrames(30, 5));
    expect(plan.boundedBy).toBe("max-frames");
    expect(plan.selectedIndexes).toEqual([0, 7, 15, 22, 29]);
    expect(plan.selectedIndexes[0]).toBe(0);
    expect(plan.selectedIndexes.at(-1)).toBe(29);
  });

  it("reports every index it did not select, so coverage is indexes rather than a share", () => {
    const plan = planGifFrames(10, 4);

    expect(plan.selectedIndexes).toEqual([0, 3, 6, 9]);
    expect(plan.omittedIndexes).toEqual([1, 2, 4, 5, 7, 8]);
    expect(
      [...plan.selectedIndexes, ...plan.omittedIndexes].sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 10 }, (_unused, index) => index));
  });

  it("selects only the first frame when the bound is one", () => {
    expect(planGifFrames(1, 1)).toMatchObject({ selectedIndexes: [0], omittedIndexes: [] });
  });

  it("rejects a bound of one for a multi-frame animation, because a sample covers the first and last", () => {
    expect(() => planGifFrames(8, 1)).toThrow(/at least 2/);
  });

  it("rejects an unusable frame count or bound", () => {
    expect(() => planGifFrames(0)).toThrow(/positive frame count/);
    expect(() => planGifFrames(3, 0)).toThrow(/positive integer/);
  });
});

describe("expandGifFrames", () => {
  it("builds one magick argv per selected frame, each coalescing to a single PNG", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    const result = await expandGifFrames(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "ok", operation: "expand-gif" });
    expect(boundary.requests).toHaveLength(3);
    expect(boundary.requests.every((request) => request.command === MAGICK_COMMAND)).toBe(true);
    expect(boundary.requests[1]?.args).toEqual([
      "-quiet",
      GIF_PATH,
      "-delete",
      "2--1",
      "-coalesce",
      "-delete",
      "0--2",
      `png:${ARTIFACTS_DIRECTORY}/frames/frame-001.png`,
    ]);
    expect(boundary.requests.map((request) => request.args.at(-1))).toEqual([
      `png:${ARTIFACTS_DIRECTORY}/frames/frame-000.png`,
      `png:${ARTIFACTS_DIRECTORY}/frames/frame-001.png`,
      `png:${ARTIFACTS_DIRECTORY}/frames/frame-002.png`,
    ]);
  });

  it("records each expanded frame with its index and a derivative carrying the parent hash", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs(96);

    const result = await expandGifFrames(options({ exec: boundary.exec, ...outputs }));

    if (result.outcome !== "ok") throw new Error(`expected ok, received ${result.outcome}`);
    expect(result.frames.map((frame) => frame.frameIndex)).toEqual(result.sampling.selectedIndexes);
    expect(result.frames.every((frame) => frame.derivative.parentSha256 === PARENT_SHA256)).toBe(
      true,
    );
    expect(result.frames.every((frame) => frame.derivative.operation === "expand-gif")).toBe(true);
    expect(result.frames.every((frame) => frame.derivative.bytes === 96)).toBe(true);
  });

  it("reports the omitted indexes when the animation exceeds the bound", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs();

    const result = await expandGifFrames(
      options({ frameCount: 10, maxFrames: 4, exec: boundary.exec, ...outputs }),
    );

    if (result.outcome !== "ok") throw new Error(`expected ok, received ${result.outcome}`);
    expect(result.sampling.boundedBy).toBe("max-frames");
    expect(result.sampling.selectedIndexes).toEqual([0, 3, 6, 9]);
    expect(result.sampling.omittedIndexes).toEqual([1, 2, 4, 5, 7, 8]);
    expect(boundary.requests).toHaveLength(4);
  });

  it("refuses to record a derivative without a parent hash", async () => {
    const boundary = fakeExec(() => ok());

    await expect(
      expandGifFrames(
        options({ parentSha256: "not-a-hash", exec: boundary.exec, ...fakeOutputs() }),
      ),
    ).rejects.toThrow(/parent SHA-256/);
    expect(boundary.requests).toHaveLength(0);
  });

  it("classifies an unusable frame count as unsupported-input without running magick", async () => {
    const boundary = fakeExec(() => ok());

    const result = await expandGifFrames(
      options({ frameCount: 0, exec: boundary.exec, ...fakeOutputs() }),
    );

    expect(result).toMatchObject({ outcome: "unsupported-input" });
    expect(boundary.requests).toHaveLength(0);
  });

  it("classifies a bound of one on a multi-frame animation as unsupported-input without running magick", async () => {
    const boundary = fakeExec(() => ok());

    const result = await expandGifFrames(
      options({ frameCount: 8, maxFrames: 1, exec: boundary.exec, ...fakeOutputs() }),
    );

    expect(result).toMatchObject({
      outcome: "unsupported-input",
      message: expect.stringContaining("at least 2"),
    });
    expect(boundary.requests).toHaveLength(0);
  });

  it("classifies a missing magick binary as tool-unavailable and reports no frames", async () => {
    const boundary = fakeExec(() => {
      throw missingBinary(MAGICK_COMMAND);
    });
    const outputs = fakeOutputs();

    const result = await expandGifFrames(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({ outcome: "tool-unavailable" });
    expect(result).not.toHaveProperty("frames");
    expect(outputs.discarded).toEqual([`${ARTIFACTS_DIRECTORY}/frames/frame-000.png`]);
  });

  it("classifies a shell-style 127 exit as tool-unavailable rather than a convert failure", async () => {
    const boundary = fakeExec(() => failed("magick: command not found", 127));

    const result = await expandGifFrames(options({ exec: boundary.exec, ...fakeOutputs() }));

    expect(result.outcome).toBe("tool-unavailable");
  });

  it("classifies a non-zero exit part-way through as convert-failed and discards every frame written so far", async () => {
    let call = 0;
    const boundary = fakeExec(() => {
      call += 1;
      return call === 2 ? failed("unable to write image") : ok();
    });
    const outputs = fakeOutputs();

    const result = await expandGifFrames(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({
      outcome: "convert-failed",
      message: expect.stringContaining("frame 1"),
    });
    expect(outputs.discarded).toEqual([
      `${ARTIFACTS_DIRECTORY}/frames/frame-000.png`,
      `${ARTIFACTS_DIRECTORY}/frames/frame-001.png`,
    ]);
  });

  it("classifies a missing decode delegate as unsupported-input rather than a failure", async () => {
    const boundary = fakeExec(() =>
      failed("magick: no decode delegate for this image format `GIF'"),
    );

    const result = await expandGifFrames(options({ exec: boundary.exec, ...fakeOutputs() }));

    expect(result.outcome).toBe("unsupported-input");
  });

  it("classifies an exceeded deadline as timeout and discards partial frames instead of reporting them", async () => {
    const boundary = fakeExec((request) =>
      request.args.includes("2--1") ? delayedResult(ok(), 500) : ok(),
    );
    const outputs = fakeOutputs();

    const result = await expandGifFrames(
      options({ timeoutMs: 40, exec: boundary.exec, ...outputs }),
    );

    expect(result).toMatchObject({ outcome: "timeout" });
    expect(result).not.toHaveProperty("frames");
    expect(outputs.discarded).toContain(`${ARTIFACTS_DIRECTORY}/frames/frame-000.png`);
  });

  it("classifies an empty frame file as convert-failed", async () => {
    const boundary = fakeExec(() => ok());
    const outputs = fakeOutputs(0);

    const result = await expandGifFrames(options({ exec: boundary.exec, ...outputs }));

    expect(result).toMatchObject({
      outcome: "convert-failed",
      message: expect.stringContaining("empty file"),
    });
  });
});
