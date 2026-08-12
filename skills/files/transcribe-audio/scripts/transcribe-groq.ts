#!/usr/bin/env -S bun --no-env-file

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo" as const;
const GROQ_MAX_UPLOAD_BYTES = 25_000_000;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const SUPPORTED_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
]);

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
  provider: "Groq";
  model: typeof GROQ_MODEL;
  source: FileIdentity;
  language: string | null;
  durationSeconds: number;
  text: string;
  segments: Segment[];
}

type FailureOutcome =
  | "access-denied"
  | "input-changed"
  | "tool-unavailable"
  | "transcription-failed"
  | "unsupported-input"
  | "timeout";

interface Failure {
  outcome: FailureOutcome;
  file: FileIdentity;
  provider: "Groq";
  model: typeof GROQ_MODEL;
  message: string;
}

interface Success {
  outcome: "ok";
  file: FileIdentity;
  provider: "Groq";
  model: typeof GROQ_MODEL;
  transcript: FileIdentity;
  coverage: {
    processedRangeSeconds: [number, number];
    segmentCount: number;
  };
}

export type GroqTranscriptionResult = Failure | Success;
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface GroqTranscriptionOptions {
  inputPath: string;
  expectedSha256: string;
  artifactsDirectory: string;
  allowHosted: boolean;
  apiKey?: string;
  language?: string;
  fetcher?: Fetcher;
  maxUploadBytes?: number;
}

export async function transcribeWithGroq(
  options: GroqTranscriptionOptions,
): Promise<GroqTranscriptionResult> {
  const inputPath = resolve(options.inputPath);
  const file = await identify(inputPath);
  const base = { file, provider: "Groq" as const, model: GROQ_MODEL };
  if (file.sha256 !== options.expectedSha256) {
    return {
      ...base,
      outcome: "input-changed",
      message: `expected SHA-256 ${options.expectedSha256}, received ${file.sha256}`,
    };
  }
  if (!options.allowHosted) {
    return {
      ...base,
      outcome: "access-denied",
      message: "uploading this audio to Groq was not explicitly authorized",
    };
  }
  if (!options.apiKey) {
    return {
      ...base,
      outcome: "tool-unavailable",
      message: "GROQ_API_KEY is unavailable in the runtime",
    };
  }

  const maxUploadBytes = options.maxUploadBytes ?? GROQ_MAX_UPLOAD_BYTES;
  if (!SUPPORTED_EXTENSIONS.has(extname(inputPath).toLowerCase())) {
    return {
      ...base,
      outcome: "unsupported-input",
      message: `Groq does not support ${extname(inputPath) || "files without an extension"}`,
    };
  }
  if (file.bytes > maxUploadBytes) {
    return {
      ...base,
      outcome: "unsupported-input",
      message: `audio is ${file.bytes} bytes; Groq accepts at most ${maxUploadBytes}`,
    };
  }

  const artifactsDirectory = resolve(options.artifactsDirectory);
  await mkdir(artifactsDirectory, { recursive: true });
  if (!(await stat(artifactsDirectory)).isDirectory())
    throw new Error(`artifacts path is not a directory: ${artifactsDirectory}`);
  const runDirectory = await mkdtemp(join(artifactsDirectory, "groq-transcription-"));
  try {
    const uploadBytes = await Bun.file(file.path).arrayBuffer();
    const uploadSha256 = createHash("sha256").update(new Uint8Array(uploadBytes)).digest("hex");
    if (uploadSha256 !== file.sha256) {
      await rm(runDirectory, { recursive: true, force: true });
      const changed = await identify(inputPath);
      return {
        ...base,
        file: changed,
        outcome: "input-changed",
        message: `audio changed before upload: ${file.sha256} became ${changed.sha256}`,
      };
    }
    const form = new FormData();
    form.append("file", new Blob([uploadBytes]), basename(file.path));
    form.append("model", GROQ_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (options.language) form.append("language", options.language);

    let response: Response;
    try {
      response = await (options.fetcher ?? fetch)(GROQ_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await rm(runDirectory, { recursive: true, force: true });
      const timeout = error instanceof DOMException && error.name === "TimeoutError";
      return {
        ...base,
        outcome: timeout ? "timeout" : "transcription-failed",
        message: timeout ? "Groq transcription timed out" : "Groq transcription request failed",
      };
    }
    if (!response.ok) {
      await rm(runDirectory, { recursive: true, force: true });
      const outcome =
        response.status === 401 || response.status === 403
          ? "access-denied"
          : response.status === 413
            ? "unsupported-input"
            : "transcription-failed";
      return {
        ...base,
        outcome,
        message: `Groq returned HTTP ${response.status}`,
      };
    }

    const transcript = parseTranscript(await response.json());
    const finalFile = await identify(inputPath);
    if (finalFile.sha256 !== file.sha256) {
      await rm(runDirectory, { recursive: true, force: true });
      return {
        ...base,
        file: finalFile,
        outcome: "input-changed",
        message: `audio changed during transcription: ${file.sha256} became ${finalFile.sha256}`,
      };
    }
    const document: TranscriptDocument = {
      formatVersion: 1,
      provider: "Groq",
      model: GROQ_MODEL,
      source: file,
      ...transcript,
    };
    const transcriptPath = join(runDirectory, "transcript.json");
    await writeFile(transcriptPath, `${JSON.stringify(document, null, 2)}\n`, {
      flag: "wx",
    });
    const transcriptIdentity = await identify(transcriptPath);
    return {
      ...base,
      outcome: "ok",
      transcript: transcriptIdentity,
      coverage: {
        processedRangeSeconds: [0, transcript.durationSeconds],
        segmentCount: transcript.segments.length,
      },
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

function parseTranscript(
  value: unknown,
): Omit<TranscriptDocument, "formatVersion" | "provider" | "model" | "source"> {
  if (!isRecord(value) || typeof value.text !== "string")
    throw new Error("Groq returned a transcript without text");
  if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0)
    throw new Error("Groq returned an invalid audio duration");
  if (!Array.isArray(value.segments)) throw new Error("Groq returned no timestamped segments");
  const segments = value.segments.map((segment, index) => {
    if (
      !isRecord(segment) ||
      typeof segment.start !== "number" ||
      !Number.isFinite(segment.start) ||
      segment.start < 0 ||
      typeof segment.end !== "number" ||
      !Number.isFinite(segment.end) ||
      segment.end < segment.start ||
      typeof segment.text !== "string"
    ) {
      throw new Error(`Groq returned an invalid segment at index ${index}`);
    }
    return { start: segment.start, end: segment.end, text: segment.text };
  });
  return {
    language: typeof value.language === "string" ? value.language : null,
    durationSeconds: value.duration,
    text: value.text,
    segments,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface CliOptions {
  inputPath: string;
  expectedSha256: string;
  artifactsDirectory: string;
  allowHosted: boolean;
  language?: string;
}

function parseArguments(args: string[]): CliOptions {
  const inputPath = args.shift();
  if (!inputPath) fail("Missing audio path");
  let expectedSha256: string | undefined;
  let artifactsDirectory: string | undefined;
  let allowHosted = false;
  let language: string | undefined;
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) fail(`Missing value for ${flag ?? "argument"}`);
    if (flag === "--expected-sha256") expectedSha256 = value.toLowerCase();
    else if (flag === "--artifacts-dir") artifactsDirectory = value;
    else if (flag === "--allow-hosted" && value === "groq") allowHosted = true;
    else if (flag === "--language" && /^[a-z]{2}$/.test(value)) language = value;
    else fail(`Unknown or invalid argument: ${flag} ${value}`);
  }
  if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256))
    fail("Require --expected-sha256 with 64 lowercase hexadecimal characters");
  if (!artifactsDirectory) fail("Require --artifacts-dir");
  return {
    inputPath,
    expectedSha256,
    artifactsDirectory,
    allowHosted,
    language,
  };
}

function fail(message: string): never {
  console.error(message);
  console.error(
    "Usage: transcribe-groq.ts <audio-path> --expected-sha256 <sha256> --artifacts-dir <directory> --allow-hosted groq [--language <code>]",
  );
  process.exit(1);
}

if (import.meta.main) {
  const options = parseArguments(Bun.argv.slice(2));
  const result = await transcribeWithGroq({
    ...options,
    ...(options.allowHosted ? { apiKey: Bun.env.GROQ_API_KEY } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.outcome === "ok" ? 0 : 2);
}
