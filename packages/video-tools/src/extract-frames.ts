import { execWithBun, type ExecBoundary } from "@caiopizzol/media-exec";
import { FFMPEG_COMMAND } from "./extract-audio.ts";
import {
  DEFAULT_TIMEOUT_MS,
  assertParentSha256,
  describeDerivative,
  discardOutputWithNode,
  prepareOutputWithNode,
  readOutputWithNode,
  resolvePath,
  runTool,
  type DiscardOutputBoundary,
  type PrepareOutputBoundary,
  type ReadOutputBoundary,
} from "@caiopizzol/media-exec";
import { planFrameSampling } from "./sample-frames.ts";
import type { ExtractFramesResult, ExtractedFrame, FrameSamplingPlan } from "./types.ts";
import { resolveWriteTarget } from "@caiopizzol/media-exec";

export interface ExtractFramesOptions {
  inputPath: string;
  parentSha256: string;
  artifactsDirectory: string;
  framesSubdirectory?: string;
  durationSeconds: number;
  frameCount?: number;
  timestampsSeconds?: readonly number[];
  maxFrames?: number;
  cwd: string;
  timeoutMs?: number;
  exec?: ExecBoundary;
  readOutput?: ReadOutputBoundary;
  prepareOutput?: PrepareOutputBoundary;
  discardOutput?: DiscardOutputBoundary;
}

// -ss before -i seeks without decoding the whole stream, -frames:v 1 writes exactly one frame, and
// -y overwrites a destination the caller already owns. One invocation per timestamp keeps each
// frame independently attributable. Overwriting is safe because resolveWriteTarget has already
// refused any destination outside the artifacts directory or onto the input.
export function buildExtractFrameArgs(
  inputPath: string,
  outputPath: string,
  timestampSeconds: number,
): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-ss",
    formatTimestamp(timestampSeconds),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-f",
    "image2",
    "-c:v",
    "png",
    outputPath,
  ];
}

export function frameFilename(index: number, timestampSeconds: number): string {
  const ordinal = String(index + 1).padStart(3, "0");
  return `frame-${ordinal}-${formatTimestamp(timestampSeconds).replace(".", "_")}s.png`;
}

export async function extractFrames(options: ExtractFramesOptions): Promise<ExtractFramesResult> {
  const inputPath = resolvePath(options.inputPath, options.cwd);
  assertParentSha256(options.parentSha256);
  let sampling: FrameSamplingPlan;
  try {
    sampling = planFrameSampling({
      durationSeconds: options.durationSeconds,
      frameCount: options.frameCount,
      timestampsSeconds: options.timestampsSeconds,
      maxFrames: options.maxFrames,
    });
  } catch (error) {
    return {
      outcome: "unsupported-input",
      operation: "extract-frames",
      inputPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const exec = options.exec ?? execWithBun;
  const readOutput = options.readOutput ?? readOutputWithNode;
  const prepareOutput = options.prepareOutput ?? prepareOutputWithNode;
  const discardOutput = options.discardOutput ?? discardOutputWithNode;
  const subdirectory = options.framesSubdirectory ?? "frames";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const frames: ExtractedFrame[] = [];
  const written: string[] = [];
  const deadline = Date.now() + timeoutMs;
  for (const [index, timestampSeconds] of sampling.timestampsSeconds.entries()) {
    const outputPath = resolveWriteTarget({
      inputPath,
      artifactsDirectory: options.artifactsDirectory,
      relativePath: `${subdirectory}/${frameFilename(index, timestampSeconds)}`,
      cwd: options.cwd,
    });
    written.push(outputPath);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      await discardAll(discardOutput, written);
      return {
        outcome: "timeout",
        operation: "extract-frames",
        inputPath,
        message: `frame extraction exceeded the ${timeoutMs} ms deadline after ${index} of ${sampling.timestampsSeconds.length} frames`,
      };
    }
    await prepareOutput(outputPath);
    const run = await runTool(
      exec,
      {
        command: FFMPEG_COMMAND,
        args: buildExtractFrameArgs(inputPath, outputPath, timestampSeconds),
        cwd: options.cwd,
      },
      remainingMs,
    );
    if (run.kind !== "result" || run.result.exitCode !== 0) {
      await discardAll(discardOutput, written);
      if (run.kind === "tool-unavailable") {
        return {
          outcome: "tool-unavailable",
          operation: "extract-frames",
          inputPath,
          message: run.message,
        };
      }
      if (run.kind === "timeout") {
        return { outcome: "timeout", operation: "extract-frames", inputPath, message: run.message };
      }
      const message =
        run.kind === "result"
          ? `ffmpeg exited with code ${run.result.exitCode} at ${timestampSeconds}s: ${run.result.stderr.trim() || "no stderr"}`
          : run.message;
      return { outcome: "extract-failed", operation: "extract-frames", inputPath, message };
    }
    try {
      frames.push({
        timestampSeconds,
        derivative: await describeDerivative(
          outputPath,
          "extract-frames",
          options.parentSha256,
          readOutput,
        ),
      });
    } catch (error) {
      await discardAll(discardOutput, written);
      return {
        outcome: "extract-failed",
        operation: "extract-frames",
        inputPath,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { outcome: "ok", operation: "extract-frames", inputPath, sampling, frames };
}

async function discardAll(
  discardOutput: DiscardOutputBoundary,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) await discardOutput(path);
}

function formatTimestamp(timestampSeconds: number): string {
  return timestampSeconds.toFixed(3);
}
