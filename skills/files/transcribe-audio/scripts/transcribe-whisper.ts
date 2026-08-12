#!/usr/bin/env -S bun --no-env-file

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const WHISPER_COMMAND = "whisper-cli";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

interface FileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

interface Segment {
  start: number;
  end: number;
  text: string;
}

interface TranscriptDocument {
  formatVersion: 1;
  engine: "whisper.cpp";
  engineVersion: string;
  model: FileIdentity & { name: "large-v3-turbo" | "large-v3" | "unknown" };
  source: FileIdentity;
  language: string;
  text: string;
  segments: Segment[];
}

type FailureOutcome =
  | "input-changed"
  | "tool-unavailable"
  | "transcription-failed"
  | "unsupported-input"
  | "timeout";

interface Failure {
  outcome: FailureOutcome;
  file: FileIdentity;
  engine: "whisper.cpp";
  message: string;
}

interface Success {
  outcome: "ok";
  file: FileIdentity;
  engine: "whisper.cpp";
  engineVersion: string;
  model: FileIdentity & { name: "large-v3-turbo" | "large-v3" | "unknown" };
  transcript: FileIdentity;
  segmentRangeSeconds: [number, number] | null;
  segmentCount: number;
}

export type WhisperTranscriptionResult = Failure | Success;

interface ExecResult {
  outcome: "ok" | "failed" | "tool-unavailable" | "timeout";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ExecBoundary = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ExecResult>;

export interface WhisperTranscriptionOptions {
  inputPath: string;
  expectedSha256: string;
  artifactsDirectory: string;
  modelPath: string;
  language?: string;
  timeoutMs?: number;
  threads?: number;
  exec?: ExecBoundary;
}

export async function transcribeWithWhisper(
  options: WhisperTranscriptionOptions,
): Promise<WhisperTranscriptionResult> {
  const inputPath = resolve(options.inputPath);
  const file = await identify(inputPath);
  const base = { file, engine: "whisper.cpp" as const };
  if (file.sha256 !== options.expectedSha256) {
    return {
      ...base,
      outcome: "input-changed",
      message: `expected SHA-256 ${options.expectedSha256}, received ${file.sha256}`,
    };
  }

  let model: FileIdentity;
  try {
    model = await identify(resolve(options.modelPath));
  } catch {
    return {
      ...base,
      outcome: "tool-unavailable",
      message: `Whisper model is unavailable: ${resolve(options.modelPath)}`,
    };
  }

  const artifactsDirectory = resolve(options.artifactsDirectory);
  await mkdir(artifactsDirectory, { recursive: true });
  if ((await lstat(artifactsDirectory)).isSymbolicLink())
    throw new Error(`artifacts directory must not be a symbolic link: ${artifactsDirectory}`);
  if (!(await stat(artifactsDirectory)).isDirectory())
    throw new Error(`artifacts path is not a directory: ${artifactsDirectory}`);
  const runDirectory = await mkdtemp(join(artifactsDirectory, "whisper-transcription-"));
  const outputPrefix = join(runDirectory, "transcript.native");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exec = options.exec ?? execCommand;

  const versionRun = await exec(WHISPER_COMMAND, ["--version"], timeoutMs);
  if (versionRun.outcome !== "ok") {
    await rm(runDirectory, { recursive: true, force: true });
    return {
      ...base,
      outcome: versionRun.outcome === "failed" ? "tool-unavailable" : versionRun.outcome,
      message:
        versionRun.outcome === "timeout"
          ? "whisper-cli version check timed out"
          : "whisper-cli is unavailable",
    };
  }
  const engineVersion = parseVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
  const args = [
    "-m",
    model.path,
    "-f",
    file.path,
    "-l",
    options.language ?? "auto",
    "-t",
    String(options.threads ?? defaultThreads()),
    // Long recordings can otherwise repeat carried text context instead of advancing through the audio.
    "--max-context",
    "0",
    "-oj",
    "-of",
    outputPrefix,
    "-np",
  ];
  const run = await exec(WHISPER_COMMAND, args, timeoutMs);
  let finalFile: FileIdentity;
  let finalModel: FileIdentity;
  try {
    [finalFile, finalModel] = await Promise.all([identify(file.path), identify(model.path)]);
  } catch {
    await rm(runDirectory, { recursive: true, force: true });
    return {
      ...base,
      outcome: "input-changed",
      message: "audio or model became unavailable during transcription",
    };
  }
  if (finalFile.sha256 !== file.sha256 || finalModel.sha256 !== model.sha256) {
    await rm(runDirectory, { recursive: true, force: true });
    return {
      ...base,
      file: finalFile,
      outcome: "input-changed",
      message:
        finalFile.sha256 !== file.sha256
          ? `audio changed during transcription: ${file.sha256} became ${finalFile.sha256}`
          : `model changed during transcription: ${model.sha256} became ${finalModel.sha256}`,
    };
  }
  if (unsupportedAudioDiagnostic(run.stderr)) {
    await rm(runDirectory, { recursive: true, force: true });
    return {
      ...base,
      outcome: "unsupported-input",
      message: lastDiagnostic(run.stderr),
    };
  }
  if (run.outcome !== "ok") {
    await rm(runDirectory, { recursive: true, force: true });
    return {
      ...base,
      outcome: run.outcome === "failed" ? "transcription-failed" : run.outcome,
      message:
        run.outcome === "timeout"
          ? "local Whisper transcription timed out"
          : run.outcome === "tool-unavailable"
            ? "whisper-cli is unavailable"
            : `whisper-cli exited with code ${run.exitCode ?? "unknown"}: ${lastDiagnostic(run.stderr)}`,
    };
  }

  try {
    const native = parseNativeTranscript(
      JSON.parse(await readFile(`${outputPrefix}.json`, "utf8")) as unknown,
    );
    await rm(`${outputPrefix}.json`, { force: true });
    const identifiedModel = { ...model, name: native.modelName };
    const document: TranscriptDocument = {
      formatVersion: 1,
      engine: "whisper.cpp",
      engineVersion,
      model: identifiedModel,
      source: file,
      language: native.language,
      text: native.segments.map((segment) => segment.text.trim()).join(" "),
      segments: native.segments,
    };
    const transcriptPath = join(runDirectory, "transcript.json");
    await writeFile(transcriptPath, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
    const transcript = await identify(transcriptPath);
    return {
      ...base,
      outcome: "ok",
      engineVersion,
      model: identifiedModel,
      transcript,
      segmentRangeSeconds:
        native.segments.length === 0
          ? null
          : [native.segments[0]!.start, native.segments.at(-1)!.end],
      segmentCount: native.segments.length,
    };
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true });
    return {
      ...base,
      outcome: "transcription-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseNativeTranscript(value: unknown): {
  language: string;
  modelName: "large-v3-turbo" | "large-v3" | "unknown";
  segments: Segment[];
} {
  if (!isRecord(value) || !Array.isArray(value.transcription))
    throw new Error("whisper-cli returned no timestamped transcription");
  const result = isRecord(value.result) ? value.result : null;
  const language = result && typeof result.language === "string" ? result.language : "unknown";
  const model = isRecord(value.model) ? value.model : null;
  const audio = model && isRecord(model.audio) ? model.audio : null;
  const text = model && isRecord(model.text) ? model.text : null;
  const largeV3 = model?.vocab === 51866 && audio?.layer === 32;
  const modelName =
    largeV3 && text?.layer === 4 ? "large-v3-turbo" : largeV3 ? "large-v3" : "unknown";
  const segments = value.transcription.map((segment, index) => {
    if (!isRecord(segment) || typeof segment.text !== "string" || !isRecord(segment.offsets))
      throw new Error(`whisper-cli returned an invalid segment at index ${index}`);
    const startMs = segment.offsets.from;
    const endMs = segment.offsets.to;
    if (
      typeof startMs !== "number" ||
      !Number.isFinite(startMs) ||
      startMs < 0 ||
      typeof endMs !== "number" ||
      !Number.isFinite(endMs) ||
      endMs < startMs
    )
      throw new Error(`whisper-cli returned invalid timestamps at segment ${index}`);
    return { start: startMs / 1000, end: endMs / 1000, text: segment.text };
  });
  return { language, modelName, segments };
}

async function identify(path: string): Promise<FileIdentity> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`input is not a regular file: ${path}`);
  const hash = createHash("sha256");
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolveStream);
    stream.on("error", reject);
  });
  return { path, bytes: details.size, sha256: hash.digest("hex") };
}

async function execCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ExecResult> {
  let process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    process = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { outcome: "tool-unavailable", exitCode: null, stdout: "", stderr: "" };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill();
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return {
      outcome: timedOut ? "timeout" : exitCode === 0 ? "ok" : "failed",
      exitCode,
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseVersion(output: string): string {
  return output.match(/whisper\.cpp version:\s*([^\s]+)/)?.[1] ?? "unknown";
}

function unsupportedAudioDiagnostic(stderr: string): boolean {
  return /failed to read audio (?:data|file)/i.test(stderr);
}

function lastDiagnostic(stderr: string): string {
  return (
    stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "no diagnostic"
  );
}

function defaultThreads(): number {
  return Math.max(1, Math.min(12, navigator.hardwareConcurrency || 4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface CliOptions {
  inputPath: string;
  expectedSha256: string;
  artifactsDirectory: string;
  modelPath: string;
  language?: string;
  timeoutMs?: number;
}

function parseArguments(args: string[]): CliOptions {
  const inputPath = args.shift();
  if (!inputPath) fail("Missing audio path");
  let expectedSha256: string | undefined;
  let artifactsDirectory: string | undefined;
  let modelPath: string | undefined;
  let language: string | undefined;
  let timeoutMs: number | undefined;
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) fail(`Missing value for ${flag ?? "argument"}`);
    if (flag === "--expected-sha256") expectedSha256 = value.toLowerCase();
    else if (flag === "--artifacts-dir") artifactsDirectory = value;
    else if (flag === "--model") modelPath = value;
    else if (flag === "--language" && /^[a-z]{2,3}$/.test(value)) language = value;
    else if (flag === "--timeout-ms" && Number.isSafeInteger(Number(value)) && Number(value) > 0)
      timeoutMs = Number(value);
    else fail(`Unknown or invalid argument: ${flag} ${value}`);
  }
  if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256))
    fail("Require --expected-sha256 with 64 lowercase hexadecimal characters");
  if (!artifactsDirectory) fail("Require --artifacts-dir");
  modelPath ??= Bun.env.WHISPER_MODEL_PATH;
  if (!modelPath) fail("Require --model or WHISPER_MODEL_PATH");
  return { inputPath, expectedSha256, artifactsDirectory, modelPath, language, timeoutMs };
}

function fail(message: string): never {
  console.error(message);
  console.error(
    "Usage: transcribe-whisper.ts <audio-path> --expected-sha256 <sha256> --artifacts-dir <directory> [--model <ggml-model-path>] [--language <code>] [--timeout-ms <milliseconds>]",
  );
  process.exit(1);
}

if (import.meta.main) {
  const result = await transcribeWithWhisper(parseArguments(Bun.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.outcome === "ok" ? 0 : 2);
}
