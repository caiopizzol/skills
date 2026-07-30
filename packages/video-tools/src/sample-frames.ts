import type { FrameSamplingPlan, SampledInterval } from "./types.ts";

export const DEFAULT_MAX_FRAMES = 12;

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
  maxFrames?: number;
}

export function planFrameSampling(input: FrameSamplingInput): FrameSamplingPlan {
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new Error("frame sampling requires a positive duration");
  }
  const maxFrames = normalizeMaxFrames(input.maxFrames);
  const durationSeconds = round(input.durationSeconds);
  return input.timestampsSeconds === undefined
    ? planEvenly(durationSeconds, input.frameCount, maxFrames)
    : planExplicit(durationSeconds, input.timestampsSeconds, maxFrames);
}

function planEvenly(durationSeconds: number, requested: number | undefined, maxFrames: number): FrameSamplingPlan {
  const requestedCount = normalizeRequestedCount(requested, maxFrames);
  const lastSample = round(Math.max(0, durationSeconds - END_MARGIN_SECONDS));
  const durationLimit = Math.max(1, Math.floor(lastSample / MIN_SPACING_SECONDS) + 1);
  const count = Math.min(requestedCount, maxFrames, durationLimit);
  const timestampsSeconds = count === 1
    ? [round(durationSeconds / 2)]
    : Array.from({ length: count }, (_unused, index) => round((index * lastSample) / (count - 1)));
  return {
    durationSeconds,
    requestedCount,
    maxFrames,
    boundedBy: boundedBy(requestedCount, maxFrames, durationLimit, count),
    timestampsSeconds,
    rejectedTimestampsSeconds: [],
    omittedIntervalsSeconds: omittedIntervals(durationSeconds, timestampsSeconds),
  };
}

function planExplicit(
  durationSeconds: number,
  requestedTimestamps: readonly number[],
  maxFrames: number,
): FrameSamplingPlan {
  const accepted: number[] = [];
  const rejectedTimestampsSeconds: number[] = [];
  for (const timestamp of requestedTimestamps) {
    if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp >= durationSeconds) {
      rejectedTimestampsSeconds.push(timestamp);
      continue;
    }
    const rounded = round(timestamp);
    if (!accepted.includes(rounded)) accepted.push(rounded);
  }
  accepted.sort((left, right) => left - right);
  const timestampsSeconds = accepted.slice(0, maxFrames);
  rejectedTimestampsSeconds.push(...accepted.slice(maxFrames));
  if (timestampsSeconds.length === 0) throw new Error("no requested timestamp falls inside the video duration");
  return {
    durationSeconds,
    requestedCount: requestedTimestamps.length,
    maxFrames,
    boundedBy: timestampsSeconds.length < accepted.length ? "max-frames" : "explicit",
    timestampsSeconds,
    rejectedTimestampsSeconds,
    omittedIntervalsSeconds: omittedIntervals(durationSeconds, timestampsSeconds),
  };
}

// Coverage is reported as the intervals no frame observed, because a frame count says nothing about
// which part of the video was seen.
function omittedIntervals(durationSeconds: number, timestampsSeconds: readonly number[]): SampledInterval[] {
  const intervals: SampledInterval[] = [];
  let cursor = 0;
  for (const timestamp of timestampsSeconds) {
    if (timestamp > cursor) intervals.push({ startSeconds: round(cursor), endSeconds: timestamp });
    cursor = timestamp;
  }
  if (durationSeconds > cursor) intervals.push({ startSeconds: round(cursor), endSeconds: durationSeconds });
  return intervals;
}

function boundedBy(
  requestedCount: number,
  maxFrames: number,
  durationLimit: number,
  count: number,
): FrameSamplingPlan["boundedBy"] {
  if (count === durationLimit && durationLimit < requestedCount) return "duration";
  if (count === maxFrames && maxFrames < requestedCount) return "max-frames";
  return "requested";
}

function normalizeMaxFrames(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FRAMES;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("maxFrames must be a positive integer");
  return value;
}

function normalizeRequestedCount(value: number | undefined, maxFrames: number): number {
  if (value === undefined) return Math.min(3, maxFrames);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("frameCount must be a positive integer");
  return value;
}

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}
