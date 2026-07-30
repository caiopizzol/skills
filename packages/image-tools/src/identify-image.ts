import { execWithBun, type ExecBoundary } from "@caiopizzol/media-exec";
import { DEFAULT_TIMEOUT_MS, resolvePath, runTool } from "@caiopizzol/media-exec";
import { IMAGE_TOOLS_FORMAT_VERSION, type IdentifyImageResult, type ImageIdentity } from "./types.ts";

export interface IdentifyImageOptions {
  inputPath: string;
  cwd: string;
  timeoutMs?: number;
  exec?: ExecBoundary;
}

export const IDENTIFY_COMMAND = "identify";

// ImageMagick prints one -format line per frame, so the line count is the frame count and the
// first line carries the format and dimensions of frame zero.
export const IDENTIFY_FORMAT = "%m %w %h\\n";

// -ping reads headers instead of decoding pixels, which is both faster and one less decode of an
// untrusted file before anything has been decided about it. -quiet keeps recoverable warnings off
// stderr so a warning is never read as a failure.
//
// ImageMagick has no equivalent of ffmpeg's -i, so nothing marks the end of options. The path is
// resolved to an absolute path before it reaches here, which is what keeps a filename beginning
// with a hyphen from being parsed as an option: an absolute path always begins with a separator.
export function buildIdentifyArgs(inputPath: string): string[] {
  return ["-quiet", "-ping", "-format", IDENTIFY_FORMAT, inputPath];
}

export function parseIdentifyOutput(output: string): ImageIdentity {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) throw new Error("identify returned no output");
  // Every line is a counted frame, so every line is validated. Trusting only the first would let a
  // malformed tail inflate the frame count, and the frame count is what decides GIF routing.
  const frames = lines.map(parseFrameLine);
  const first = frames[0];
  if (first === undefined) throw new Error("identify returned no output");
  return {
    formatVersion: IMAGE_TOOLS_FORMAT_VERSION,
    format: first.format,
    width: first.width,
    height: first.height,
    frameCount: frames.length,
  };
}

function parseFrameLine(line: string): { format: string; width: number; height: number } {
  const fields = line.split(/\s+/);
  if (fields.length !== 3) throw new Error(`identify returned an unreadable frame line: ${line}`);
  const [format, rawWidth, rawHeight] = fields;
  if (format === undefined || format === "") throw new Error("identify returned no format");
  const width = parseDimension(rawWidth);
  const height = parseDimension(rawHeight);
  if (width === null || height === null) throw new Error(`identify returned unusable dimensions: ${line}`);
  return { format, width, height };
}

export async function identifyImage(options: IdentifyImageOptions): Promise<IdentifyImageResult> {
  const exec = options.exec ?? execWithBun;
  const inputPath = resolvePath(options.inputPath, options.cwd);
  const run = await runTool(
    exec,
    { command: IDENTIFY_COMMAND, args: buildIdentifyArgs(inputPath), cwd: options.cwd },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // -ping reads headers and writes nothing, so a timeout needs no settling wait.
    { writesOutput: false },
  );
  if (run.kind === "tool-unavailable") {
    return { outcome: "tool-unavailable", operation: "identify", inputPath, message: run.message };
  }
  if (run.kind === "timeout") return { outcome: "timeout", operation: "identify", inputPath, message: run.message };
  if (run.kind === "error") return { outcome: "identify-failed", operation: "identify", inputPath, message: run.message };
  if (run.result.exitCode !== 0) {
    const stderr = run.result.stderr.trim();
    return {
      outcome: isUndecodable(stderr) ? "unsupported-input" : "identify-failed",
      operation: "identify",
      inputPath,
      message: `identify exited with code ${run.result.exitCode}: ${stderr || "no stderr"}`,
    };
  }
  try {
    return { outcome: "ok", operation: "identify", inputPath, identity: parseIdentifyOutput(run.result.stdout) };
  } catch (error) {
    return {
      outcome: "identify-failed",
      operation: "identify",
      inputPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// The tool running and answering that it cannot read this format is a statement about the input,
// not a broken run. Keep it narrow: anything else non-zero stays a failure.
export function isUndecodable(stderr: string): boolean {
  return /no decode delegate|unsupported image format/i.test(stderr);
}

function parseDimension(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
