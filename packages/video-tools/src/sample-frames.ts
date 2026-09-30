import type { FrameSamplingPlan, SampledInterval } from "./types.ts";

export const DEFAULT_FRAME_COUNT = 5;

// ffmpeg cannot seek to the exact end of a stream reliably, so the last sample sits just inside it.
const END_MARGIN_SECONDS = 0.1;

// Two frames closer together than this describe the same moment, so requesting more of them buys
// no coverage. This is what bounds a requested count that the duration cannot support.
const MIN_SPACING_SECONDS = 1;

const PRECISION = 1000;

export interface FrameSamplingInput {
  durationSeconds: number;
  frameCount?: number;
  timestampsSeconds?: readonly number[];
}

export function planFrameSampling(input: FrameSamplingInput): FrameSamplingPlan {
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new Error("frame sampling requires a positive duration");
  }
  const durationSeconds = round(input.durationSeconds);
  return input.timestampsSeconds === undefined
    ? planEvenly(durationSeconds, input.frameCount)
    : planExplicit(durationSeconds, input.timestampsSeconds);
}

function planEvenly(durationSeconds: number, requested: number | undefined): FrameSamplingPlan {
  const requestedCount = normalizeRequestedCount(requested);
  const lastSample = lastSampleSeconds(durationSeconds);
  const durationLimit = Math.max(1, Math.floor(lastSample / MIN_SPACING_SECONDS) + 1);
  const count = Math.min(requestedCount, durationLimit);
  const timestampsSeconds =
    count === 1
      ? [round(durationSeconds / 2)]
      : Array.from({ length: count }, (_unused, index) =>
          round((index * lastSample) / (count - 1)),
        );
  return {
    durationSeconds,
    requestedCount,
    boundedBy: count < requestedCount ? "duration" : "requested",
    timestampsSeconds,
    rejectedTimestampsSeconds: [],
    omittedIntervalsSeconds: omittedIntervals(durationSeconds, timestampsSeconds),
  };
}

function planExplicit(
  durationSeconds: number,
  requestedTimestamps: readonly number[],
): FrameSamplingPlan {
  const lastSample = lastSampleSeconds(durationSeconds);
  const timestampsSeconds: number[] = [];
  const rejectedTimestampsSeconds: number[] = [];
  for (const timestamp of requestedTimestamps) {
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > lastSample) {
      rejectedTimestampsSeconds.push(timestamp);
      continue;
    }
    const rounded = round(timestamp);
    if (!timestampsSeconds.includes(rounded)) timestampsSeconds.push(rounded);
  }
  timestampsSeconds.sort((left, right) => left - right);
  if (timestampsSeconds.length === 0)
    throw new Error("no requested timestamp falls inside the video duration");
  return {
    durationSeconds,
    requestedCount: requestedTimestamps.length,
    boundedBy: "explicit",
    timestampsSeconds,
    rejectedTimestampsSeconds,
    omittedIntervalsSeconds: omittedIntervals(durationSeconds, timestampsSeconds),
  };
}

// Coverage is reported as the intervals no frame observed, because a frame count says nothing about
// which part of the video was seen.
function omittedIntervals(
  durationSeconds: number,
  timestampsSeconds: readonly number[],
): SampledInterval[] {
  const intervals: SampledInterval[] = [];
  let cursor = 0;
  for (const timestamp of timestampsSeconds) {
    if (timestamp > cursor) intervals.push({ startSeconds: round(cursor), endSeconds: timestamp });
    cursor = timestamp;
  }
  if (durationSeconds > cursor)
    intervals.push({ startSeconds: round(cursor), endSeconds: durationSeconds });
  return intervals;
}

function lastSampleSeconds(durationSeconds: number): number {
  return round(Math.max(0, durationSeconds - END_MARGIN_SECONDS));
}

function normalizeRequestedCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FRAME_COUNT;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("frameCount must be a positive integer");
  return value;
}

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}
