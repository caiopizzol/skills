import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecRequest, ExecResult } from "../../src/index.ts";

export const CWD = "/fixture/run";
export const ARTIFACTS_DIRECTORY = "/fixture/run/artifacts";
export const INPUT_PATH = "/fixture/run/originals/fixture-mp4.mp4";

// The parent hash is the committed mp4 fixture's real SHA-256, so a derivative record in a test
// points at bytes that exist rather than at a placeholder.
export const PARENT_SHA256 = "2b15eb34cdd78d75dc901c06abcddf140702b90f2b9c12e833ecec77a940fdc3";

export const PROBE_FIXTURE_DIRECTORY = join(import.meta.dirname, "probe");
export const VIDEO_FIXTURE_DIRECTORY = join(import.meta.dirname, "videos");

export function readProbeFixture(name: "mp4" | "mov" | "webm"): string {
  return readFileSync(join(PROBE_FIXTURE_DIRECTORY, `${name}.json`), "utf8");
}

export interface VideoFixtureManifest {
  schemaVersion: number;
  fixtures: Array<{
    filename: string;
    mediaType: string;
    container: string;
    videoCodec: string;
    audioCodec: string;
    durationSeconds: number;
    width: number;
    height: number;
    sampleTimesSeconds: number[];
    expectedText: string[];
    expectedShapes: string[];
    expectedTranscript: string;
    bytes: number;
    sha256: string;
  }>;
}

export function readVideoManifest(): VideoFixtureManifest {
  return JSON.parse(readFileSync(join(VIDEO_FIXTURE_DIRECTORY, "manifest.json"), "utf8")) as VideoFixtureManifest;
}

export type ExecHandler = (request: ExecRequest) => ExecResult | Promise<ExecResult>;

export interface RecordingExec {
  exec: (request: ExecRequest) => Promise<ExecResult>;
  requests: ExecRequest[];
}

export function fakeExec(handler: ExecHandler): RecordingExec {
  const requests: ExecRequest[] = [];
  return {
    requests,
    exec: async (request) => {
      requests.push(request);
      return handler(request);
    },
  };
}

export function ok(stdout = ""): ExecResult {
  return { exitCode: 0, stdout, stderr: "" };
}

export function failed(stderr: string, exitCode = 1): ExecResult {
  return { exitCode, stdout: "", stderr };
}

export function missingBinary(command: string): Error {
  const error = new Error(`spawn ${command} ENOENT`);
  Object.assign(error, { code: "ENOENT" });
  return error;
}

export interface RecordingOutputs {
  readOutput: (path: string) => Promise<Uint8Array>;
  prepareOutput: (path: string) => Promise<void>;
  discardOutput: (path: string) => Promise<void>;
  prepared: string[];
  discarded: string[];
  read: string[];
}

export function fakeOutputs(bytesPerFile = 64): RecordingOutputs {
  const prepared: string[] = [];
  const discarded: string[] = [];
  const read: string[] = [];
  return {
    prepared,
    discarded,
    read,
    prepareOutput: async (path) => {
      prepared.push(path);
    },
    discardOutput: async (path) => {
      discarded.push(path);
    },
    readOutput: async (path) => {
      read.push(path);
      return new Uint8Array(bytesPerFile).fill(path.length % 251);
    },
  };
}

export function delayedResult(result: ExecResult, delayMs: number): Promise<ExecResult> {
  return new Promise((resolveDelayed) => {
    setTimeout(() => resolveDelayed(result), delayMs);
  });
}
