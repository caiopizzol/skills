import { execWithBun, type ExecBoundary } from "@caiopizzol/media-exec";
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
import type { AudioStreamSelection, ExtractAudioResult, VideoProbe } from "./types.ts";
import { resolveWriteTarget } from "@caiopizzol/media-exec";

export const FFMPEG_COMMAND = "ffmpeg";

export const AUDIO_SAMPLE_RATE_HZ = 16_000;
export const AUDIO_CHANNELS = 1;

export interface ExtractAudioOptions {
  inputPath: string;
  parentSha256: string;
  artifactsDirectory: string;
  relativePath?: string;
  probe: VideoProbe;
  cwd: string;
  timeoutMs?: number;
  exec?: ExecBoundary;
  readOutput?: ReadOutputBoundary;
  prepareOutput?: PrepareOutputBoundary;
  discardOutput?: DiscardOutputBoundary;
}

// -i carries the input so a filename beginning with a hyphen stays a filename, and -n refuses to
// overwrite anything already at the destination.
// Which audio streams exist, and which this run will read. Extraction currently reads one stream,
// because a source with many tracks would otherwise multiply derivative bytes without being asked.
// The omitted indexes are what keep that bound honest.
export function planAudioStreams(probe: VideoProbe, selectedStreamIndex?: number): AudioStreamSelection {
  const availableStreamIndexes = probe.streams.filter((s) => s.codecType === "audio").map((s) => s.index);
  const first = availableStreamIndexes[0];
  const selected = selectedStreamIndex ?? first;
  const selectedStreamIndexes = selected === undefined || !availableStreamIndexes.includes(selected) ? [] : [selected];
  return {
    availableStreamIndexes,
    selectedStreamIndexes,
    omittedStreamIndexes: availableStreamIndexes.filter((index) => !selectedStreamIndexes.includes(index)),
  };
}

export function buildExtractAudioArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-map",
    "0:a:0",
    "-ac",
    String(AUDIO_CHANNELS),
    "-ar",
    String(AUDIO_SAMPLE_RATE_HZ),
    "-acodec",
    "pcm_s16le",
    "-f",
    "wav",
    outputPath,
  ];
}

export async function extractAudio(options: ExtractAudioOptions): Promise<ExtractAudioResult> {
  const inputPath = resolvePath(options.inputPath, options.cwd);
  assertParentSha256(options.parentSha256);
  if (!options.probe.hasAudioStream) {
    return {
      outcome: "unsupported-input",
      operation: "extract-audio",
      inputPath,
      message: "the probe reports no audio stream, so no audio was extracted",
    };
  }
  const selection = planAudioStreams(options.probe);
  const exec = options.exec ?? execWithBun;
  const readOutput = options.readOutput ?? readOutputWithNode;
  const prepareOutput = options.prepareOutput ?? prepareOutputWithNode;
  const discardOutput = options.discardOutput ?? discardOutputWithNode;
  const outputPath = resolveWriteTarget({
    inputPath,
    artifactsDirectory: options.artifactsDirectory,
    relativePath: options.relativePath ?? "audio.wav",
    cwd: options.cwd,
  });
  await prepareOutput(outputPath);
  const run = await runTool(
    exec,
    { command: FFMPEG_COMMAND, args: buildExtractAudioArgs(inputPath, outputPath), cwd: options.cwd },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (run.kind !== "result" || run.result.exitCode !== 0) {
    await discardOutput(outputPath);
    if (run.kind === "tool-unavailable") {
      return { outcome: "tool-unavailable", operation: "extract-audio", inputPath, message: run.message };
    }
    if (run.kind === "timeout") {
      return { outcome: "timeout", operation: "extract-audio", inputPath, message: run.message };
    }
    const message = run.kind === "result"
      ? `ffmpeg exited with code ${run.result.exitCode}: ${run.result.stderr.trim() || "no stderr"}`
      : run.message;
    return { outcome: "extract-failed", operation: "extract-audio", inputPath, message };
  }
  try {
    const derivative = await describeDerivative(outputPath, "extract-audio", options.parentSha256, readOutput);
    return {
      outcome: "ok",
      operation: "extract-audio",
      inputPath,
      selection,
      derivative: { ...derivative, sourceStreamIndex: selection.selectedStreamIndexes[0] ?? 0 },
    };
  } catch (error) {
    await discardOutput(outputPath);
    return {
      outcome: "extract-failed",
      operation: "extract-audio",
      inputPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
