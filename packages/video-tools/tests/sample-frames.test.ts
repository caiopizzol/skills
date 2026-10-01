import { describe, expect, it } from "vite-plus/test";
import { planFrameSampling } from "../src/index.ts";

describe("planFrameSampling", () => {
  it("covers the beginning, middle, and end of a short video", () => {
    const plan = planFrameSampling({ durationSeconds: 6, frameCount: 3 });

    expect(plan.timestampsSeconds).toEqual([0, 2.95, 5.9]);
    expect(plan.timestampsSeconds[0]).toBe(0);
    expect(plan.timestampsSeconds.at(-1)).toBeLessThan(6);
    expect(plan.boundedBy).toBe("requested");
  });

  it("samples five evenly spaced frames when no count is requested", () => {
    const plan = planFrameSampling({ durationSeconds: 6 });

    expect(plan.requestedCount).toBe(5);
    expect(plan.timestampsSeconds).toEqual([0, 1.475, 2.95, 4.425, 5.9]);
    expect(plan.boundedBy).toBe("requested");
  });

  it("is deterministic for the same inputs", () => {
    const first = planFrameSampling({ durationSeconds: 6.008, frameCount: 5 });
    const second = planFrameSampling({ durationSeconds: 6.008, frameCount: 5 });

    expect(first).toEqual(second);
  });

  it("never places a timestamp at or beyond the duration", () => {
    for (const durationSeconds of [1, 2.5, 6, 6.008, 121.75]) {
      const plan = planFrameSampling({ durationSeconds, frameCount: 12 });
      expect(
        plan.timestampsSeconds.every((timestamp) => timestamp >= 0 && timestamp < durationSeconds),
      ).toBe(true);
    }
  });

  it("bounds a requested count the duration cannot support", () => {
    const plan = planFrameSampling({ durationSeconds: 3, frameCount: 40 });

    expect(plan.requestedCount).toBe(40);
    expect(plan.timestampsSeconds).toEqual([0, 1.45, 2.9]);
    expect(plan.boundedBy).toBe("duration");
  });

  it("samples every requested frame the duration supports", () => {
    const plan = planFrameSampling({ durationSeconds: 600, frameCount: 500 });

    expect(plan.timestampsSeconds).toHaveLength(500);
    expect(plan.boundedBy).toBe("requested");
  });

  it("samples the midpoint when only one frame fits", () => {
    const plan = planFrameSampling({ durationSeconds: 0.5, frameCount: 3 });

    expect(plan.timestampsSeconds).toEqual([0.25]);
  });

  it("reports omitted intervals rather than a coverage percentage", () => {
    const plan = planFrameSampling({ durationSeconds: 6, frameCount: 3 });

    expect(plan.omittedIntervalsSeconds).toEqual([
      { startSeconds: 0, endSeconds: 2.95 },
      { startSeconds: 2.95, endSeconds: 5.9 },
      { startSeconds: 5.9, endSeconds: 6 },
    ]);
  });

  it("accepts explicit timestamps, sorts them, and rejects any outside the duration", () => {
    const plan = planFrameSampling({ durationSeconds: 6, timestampsSeconds: [5, 1, 3, 9, -1, 3] });

    expect(plan.timestampsSeconds).toEqual([1, 3, 5]);
    expect(plan.rejectedTimestampsSeconds).toEqual([9, -1]);
    expect(plan.boundedBy).toBe("explicit");
  });

  it("keeps every explicit timestamp and rejects those too close to the end", () => {
    const timestampsSeconds = Array.from({ length: 40 }, (_unused, index) => index * 0.1);
    const plan = planFrameSampling({
      durationSeconds: 6,
      timestampsSeconds: [...timestampsSeconds, 5.9, 5.95],
    });

    expect(plan.timestampsSeconds).toHaveLength(41);
    expect(plan.timestampsSeconds.at(-1)).toBe(5.9);
    expect(plan.rejectedTimestampsSeconds).toEqual([5.95]);
  });

  it("rejects an unusable duration and an explicit list with nothing inside it", () => {
    expect(() => planFrameSampling({ durationSeconds: 0, frameCount: 3 })).toThrow(
      /positive duration/,
    );
    expect(() => planFrameSampling({ durationSeconds: 6, timestampsSeconds: [7, 8] })).toThrow(
      /inside the video duration/,
    );
    expect(() => planFrameSampling({ durationSeconds: 6, frameCount: 1.5 })).toThrow(
      /positive integer/,
    );
  });
});
