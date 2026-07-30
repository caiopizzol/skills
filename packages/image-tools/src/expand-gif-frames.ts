import { execWithBun, type ExecBoundary } from "@caiopizzol/media-exec";
import { MAGICK_COMMAND } from "./convert-image.ts";
import { isUndecodable } from "./identify-image.ts";
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
import type { ExpandGifFramesResult, ExpandedGifFrame, GifFramePlan } from "./types.ts";
import { resolveWriteTarget } from "@caiopizzol/media-exec";

export const DEFAULT_MAX_GIF_FRAMES = 12;

export interface ExpandGifFramesOptions {
  inputPath: string;
  parentSha256: string;
  artifactsDirectory: string;
  framesSubdirectory?: string;
  frameCount: number;
  maxFrames?: number;
  cwd: string;
  timeoutMs?: number;
  exec?: ExecBoundary;
  readOutput?: ReadOutputBoundary;
  prepareOutput?: PrepareOutputBoundary;
  discardOutput?: DiscardOutputBoundary;
}

// A GIF frame is a patch over the frames before it, so a frame read on its own is not the image the
// animation shows at that moment. -coalesce rebuilds each frame into a full picture.
//
// The frames after the wanted one are dropped before coalescing, since rebuilding frame n needs
// only frames 0 through n, and `-delete 0--2` then keeps the last surviving image. ImageMagick
// ignores a delete range naming indexes that do not exist, so both deletes are no-ops for the first
// and last frame rather than errors.
//
// The input path is resolved to an absolute path before it reaches here, so a filename beginning
// with a hyphen cannot be parsed as an option. Nothing is appended to it: the frame is selected by
// operators, not by a bracket suffix on the filename.
export function buildExpandGifFrameArgs(
  inputPath: string,
  outputPath: string,
  frameIndex: number,
): string[] {
  return [
    "-quiet",
    inputPath,
    "-delete",
    `${frameIndex + 1}--1`,
    "-coalesce",
    "-delete",
    "0--2",
    `png:${outputPath}`,
  ];
}

export function gifFrameFilename(frameIndex: number): string {
  return `frame-${String(frameIndex).padStart(3, "0")}.png`;
}

// Selection is deterministic: the same frame count and the same bound always select the same
// indexes, so a second reading of the same GIF is comparable to the first. The first and last frames
// are always selected, because an animation's opening and closing states are what a reader is most
// often asked about.
export function planGifFrames(
  frameCount: number,
  maxFrames: number = DEFAULT_MAX_GIF_FRAMES,
): GifFramePlan {
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    throw new Error("gif frame selection requires a positive frame count");
  }
  if (!Number.isSafeInteger(maxFrames) || maxFrames <= 0)
    throw new Error("maxFrames must be a positive integer");
  const allIndexes = Array.from({ length: frameCount }, (_unused, index) => index);
  if (frameCount <= maxFrames) {
    return {
      frameCount,
      maxFrames,
      boundedBy: "frame-count",
      selectedIndexes: allIndexes,
      omittedIndexes: [],
    };
  }
  // Sampling always covers the first and last frames, which takes two slots. A bound of one asks for
  // a sample that cannot do that, so it is refused rather than quietly answered with a first frame
  // the caller would read as a covered animation.
  if (maxFrames < 2) {
    throw new Error(
      `maxFrames must be at least 2 to sample a ${frameCount}-frame animation, because a sample covers the first and last frames`,
    );
  }
  const selectedIndexes = Array.from({ length: maxFrames }, (_unused, position) =>
    Math.round((position * (frameCount - 1)) / (maxFrames - 1)),
  );
  const selected = new Set(selectedIndexes);
  return {
    frameCount,
    maxFrames,
    boundedBy: "max-frames",
    selectedIndexes,
    omittedIndexes: allIndexes.filter((index) => !selected.has(index)),
  };
}

export async function expandGifFrames(
  options: ExpandGifFramesOptions,
): Promise<ExpandGifFramesResult> {
  const inputPath = resolvePath(options.inputPath, options.cwd);
  assertParentSha256(options.parentSha256);
  let sampling: GifFramePlan;
  try {
    sampling = planGifFrames(options.frameCount, options.maxFrames ?? DEFAULT_MAX_GIF_FRAMES);
  } catch (error) {
    return {
      outcome: "unsupported-input",
      operation: "expand-gif",
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
  const frames: ExpandedGifFrame[] = [];
  const written: string[] = [];
  const deadline = Date.now() + timeoutMs;
  for (const frameIndex of sampling.selectedIndexes) {
    const outputPath = resolveWriteTarget({
      inputPath,
      artifactsDirectory: options.artifactsDirectory,
      relativePath: `${subdirectory}/${gifFrameFilename(frameIndex)}`,
      cwd: options.cwd,
    });
    written.push(outputPath);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      await discardAll(discardOutput, written);
      return {
        outcome: "timeout",
        operation: "expand-gif",
        inputPath,
        message: `gif expansion exceeded the ${timeoutMs} ms deadline after ${frames.length} of ${sampling.selectedIndexes.length} frames`,
      };
    }
    await prepareOutput(outputPath);
    const run = await runTool(
      exec,
      {
        command: MAGICK_COMMAND,
        args: buildExpandGifFrameArgs(inputPath, outputPath, frameIndex),
        cwd: options.cwd,
      },
      remainingMs,
    );
    if (run.kind !== "result" || run.result.exitCode !== 0) {
      await discardAll(discardOutput, written);
      if (run.kind === "tool-unavailable") {
        return {
          outcome: "tool-unavailable",
          operation: "expand-gif",
          inputPath,
          message: run.message,
        };
      }
      if (run.kind === "timeout")
        return { outcome: "timeout", operation: "expand-gif", inputPath, message: run.message };
      if (run.kind === "error") {
        return {
          outcome: "convert-failed",
          operation: "expand-gif",
          inputPath,
          message: run.message,
        };
      }
      const stderr = run.result.stderr.trim();
      return {
        outcome: isUndecodable(stderr) ? "unsupported-input" : "convert-failed",
        operation: "expand-gif",
        inputPath,
        message: `magick exited with code ${run.result.exitCode} at frame ${frameIndex}: ${stderr || "no stderr"}`,
      };
    }
    try {
      frames.push({
        frameIndex,
        derivative: await describeDerivative(
          outputPath,
          "expand-gif",
          options.parentSha256,
          readOutput,
        ),
      });
    } catch (error) {
      await discardAll(discardOutput, written);
      return {
        outcome: "convert-failed",
        operation: "expand-gif",
        inputPath,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { outcome: "ok", operation: "expand-gif", inputPath, sampling, frames };
}

async function discardAll(
  discardOutput: DiscardOutputBoundary,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) await discardOutput(path);
}
