import { execWithBun, type ExecBoundary } from "@caiopizzol/media-exec";
import { DEFAULT_TIMEOUT_MS, resolvePath, runTool } from "@caiopizzol/media-exec";
import {
  VIDEO_TOOLS_FORMAT_VERSION,
  type ProbeVideoResult,
  type VideoProbe,
  type VideoStream,
  type VideoStreamKind,
} from "./types.ts";

export interface ProbeVideoOptions {
  inputPath: string;
  cwd: string;
  timeoutMs?: number;
  exec?: ExecBoundary;
}

export const FFPROBE_COMMAND = "ffprobe";

// The path travels as the value of -i so a filename beginning with a hyphen is read as a filename
// rather than as an option, and the vector is always argv so no shell ever sees it.
export function buildProbeArgs(inputPath: string): string[] {
  return ["-hide_banner", "-loglevel", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", inputPath];
}

export function parseProbeOutput(output: string): VideoProbe {
  const trimmed = output.trim();
  if (trimmed === "") throw new Error("ffprobe returned no output");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error("ffprobe output must be an object");
  const format = parsed.format;
  if (!isRecord(format)) throw new Error("ffprobe output is missing the format object");
  const formatName = typeof format.format_name === "string" ? format.format_name : null;
  if (formatName === null || formatName === "") throw new Error("ffprobe output is missing format_name");
  const durationSeconds = parseNumber(format.duration);
  if (durationSeconds === null || durationSeconds <= 0) throw new Error("ffprobe output is missing a positive duration");
  if (!Array.isArray(parsed.streams)) throw new Error("ffprobe output is missing the streams array");
  const streams = parsed.streams.map((stream, index) => parseStream(stream, index));
  return {
    formatVersion: VIDEO_TOOLS_FORMAT_VERSION,
    formatName,
    containers: formatName.split(",").map((name) => name.trim()).filter((name) => name !== ""),
    durationSeconds,
    streams,
    hasVideoStream: streams.some((stream) => stream.codecType === "video"),
    hasAudioStream: streams.some((stream) => stream.codecType === "audio"),
  };
}

export async function probeVideo(options: ProbeVideoOptions): Promise<ProbeVideoResult> {
  const exec = options.exec ?? execWithBun;
  const inputPath = resolvePath(options.inputPath, options.cwd);
  const run = await runTool(
    exec,
    { command: FFPROBE_COMMAND, args: buildProbeArgs(inputPath), cwd: options.cwd },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // A probe reads metadata and writes nothing, so a timeout needs no settling wait.
    { writesOutput: false },
  );
  if (run.kind === "tool-unavailable") {
    return { outcome: "tool-unavailable", operation: "probe", inputPath, message: run.message };
  }
  if (run.kind === "timeout") return { outcome: "timeout", operation: "probe", inputPath, message: run.message };
  if (run.kind === "error") return { outcome: "probe-failed", operation: "probe", inputPath, message: run.message };
  if (run.result.exitCode !== 0) {
    return {
      outcome: "probe-failed",
      operation: "probe",
      inputPath,
      message: `ffprobe exited with code ${run.result.exitCode}: ${run.result.stderr.trim() || "no stderr"}`,
    };
  }
  let probe: VideoProbe;
  try {
    probe = parseProbeOutput(run.result.stdout);
  } catch (error) {
    return {
      outcome: "probe-failed",
      operation: "probe",
      inputPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!probe.hasVideoStream) {
    return {
      outcome: "unsupported-input",
      operation: "probe",
      inputPath,
      message: `the file carries no video stream, format ${probe.formatName}`,
    };
  }
  return { outcome: "ok", operation: "probe", inputPath, probe };
}

function parseStream(value: unknown, index: number): VideoStream {
  if (!isRecord(value)) throw new Error(`ffprobe stream ${index} must be an object`);
  const declaredIndex = parseNumber(value.index);
  return {
    index: declaredIndex === null ? index : declaredIndex,
    codecType: parseStreamKind(value.codec_type),
    codecName: typeof value.codec_name === "string" ? value.codec_name : null,
    width: parseNumber(value.width),
    height: parseNumber(value.height),
    channels: parseNumber(value.channels),
  };
}

function parseStreamKind(value: unknown): VideoStreamKind {
  if (value === "video" || value === "audio") return value;
  return "other";
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
