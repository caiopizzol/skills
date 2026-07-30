import { execWithBun, type ExecBoundary } from "@caiopizzol/media-exec";
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
import type { ConvertImageResult } from "./types.ts";
import { resolveWriteTarget } from "@caiopizzol/media-exec";

export const MAGICK_COMMAND = "magick";

export interface ConvertImageOptions {
  inputPath: string;
  parentSha256: string;
  artifactsDirectory: string;
  relativePath?: string;
  cwd: string;
  timeoutMs?: number;
  exec?: ExecBoundary;
  readOutput?: ReadOutputBoundary;
  prepareOutput?: PrepareOutputBoundary;
  discardOutput?: DiscardOutputBoundary;
}

// The input is read, never written: the only destination in this vector is the output, which
// resolveWriteTarget has already refused if it lands anywhere but the artifacts directory.
//
// -delete 1--1 drops every image after the first, so a multi-image container produces exactly one
// derivative instead of the numbered set ImageMagick would otherwise write. It silently does
// nothing on a single-image input, which is the normal case here.
//
// The png: prefix names the output coder explicitly, so the derivative is a PNG because the argv
// said so rather than because the filename ended in .png.
export function buildConvertArgs(inputPath: string, outputPath: string): string[] {
  return ["-quiet", inputPath, "-delete", "1--1", `png:${outputPath}`];
}

export async function convertImage(options: ConvertImageOptions): Promise<ConvertImageResult> {
  const inputPath = resolvePath(options.inputPath, options.cwd);
  assertParentSha256(options.parentSha256);
  const exec = options.exec ?? execWithBun;
  const readOutput = options.readOutput ?? readOutputWithNode;
  const prepareOutput = options.prepareOutput ?? prepareOutputWithNode;
  const discardOutput = options.discardOutput ?? discardOutputWithNode;
  const outputPath = resolveWriteTarget({
    inputPath,
    artifactsDirectory: options.artifactsDirectory,
    relativePath: options.relativePath ?? "converted.png",
    cwd: options.cwd,
  });
  await prepareOutput(outputPath);
  const run = await runTool(
    exec,
    { command: MAGICK_COMMAND, args: buildConvertArgs(inputPath, outputPath), cwd: options.cwd },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (run.kind !== "result" || run.result.exitCode !== 0) {
    await discardOutput(outputPath);
    if (run.kind === "tool-unavailable") {
      return { outcome: "tool-unavailable", operation: "convert", inputPath, message: run.message };
    }
    if (run.kind === "timeout") return { outcome: "timeout", operation: "convert", inputPath, message: run.message };
    if (run.kind === "error") return { outcome: "convert-failed", operation: "convert", inputPath, message: run.message };
    const stderr = run.result.stderr.trim();
    return {
      outcome: isUndecodable(stderr) ? "unsupported-input" : "convert-failed",
      operation: "convert",
      inputPath,
      message: `magick exited with code ${run.result.exitCode}: ${stderr || "no stderr"}`,
    };
  }
  try {
    return {
      outcome: "ok",
      operation: "convert",
      inputPath,
      derivative: await describeDerivative(outputPath, "convert", options.parentSha256, readOutput),
    };
  } catch (error) {
    await discardOutput(outputPath);
    return {
      outcome: "convert-failed",
      operation: "convert",
      inputPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
