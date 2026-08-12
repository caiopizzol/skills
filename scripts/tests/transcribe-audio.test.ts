import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  transcribeWithWhisper,
  type ExecBoundary,
} from "../../skills/files/transcribe-audio/scripts/transcribe-whisper.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  inputPath: string;
  modelPath: string;
  sha256: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "transcribe-audio-"));
  temporary.push(root);
  const inputPath = join(root, "audio.mp3");
  const modelPath = join(root, "ggml-large-v3-turbo.bin");
  const bytes = Buffer.from("audio bytes");
  await writeFile(inputPath, bytes);
  await writeFile(modelPath, "model bytes");
  return {
    inputPath,
    modelPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    root,
  };
}

function workingExec(requests: string[][]): ExecBoundary {
  return async (command, args) => {
    requests.push([command, ...args]);
    if (args.includes("--version"))
      return {
        outcome: "ok",
        exitCode: 0,
        stdout: "whisper.cpp version: 1.9.2\n",
        stderr: "",
      };
    const outputPrefix = args[args.indexOf("-of") + 1];
    if (!outputPrefix) throw new Error("missing output prefix");
    await writeFile(
      `${outputPrefix}.json`,
      JSON.stringify({
        model: {
          vocab: 51866,
          audio: { layer: 32 },
          text: { layer: 4 },
        },
        result: { language: "en" },
        transcription: [
          { offsets: { from: 0, to: 2000 }, text: "First segment." },
          { offsets: { from: 2000, to: 4000 }, text: "Second segment." },
        ],
      }),
    );
    return { outcome: "ok", exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("local Whisper transcription", () => {
  it("stops on a source hash mismatch before creating artifacts or running tools", async () => {
    const { inputPath, modelPath, root } = await fixture();
    const artifactsDirectory = join(root, "artifacts");
    let called = false;

    const result = await transcribeWithWhisper({
      inputPath,
      expectedSha256: "a".repeat(64),
      artifactsDirectory,
      modelPath,
      exec: async () => {
        called = true;
        return { outcome: "ok", exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.outcome).toBe("input-changed");
    expect(called).toBe(false);
    expect(await readdir(artifactsDirectory).catch(() => [])).toEqual([]);
  });

  it("reports a missing local model without running whisper-cli", async () => {
    const { inputPath, sha256, root } = await fixture();
    let called = false;

    const result = await transcribeWithWhisper({
      inputPath,
      expectedSha256: sha256,
      artifactsDirectory: join(root, "artifacts"),
      modelPath: join(root, "missing-model.bin"),
      exec: async () => {
        called = true;
        return { outcome: "ok", exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.outcome).toBe("tool-unavailable");
    expect(called).toBe(false);
  });

  it("runs whisper-cli without a shell and writes a source-bound timestamped transcript", async () => {
    const { inputPath, modelPath, sha256, root } = await fixture();
    const requests: string[][] = [];

    const result = await transcribeWithWhisper({
      inputPath,
      expectedSha256: sha256,
      artifactsDirectory: join(root, "artifacts"),
      modelPath,
      language: "en",
      threads: 6,
      exec: workingExec(requests),
    });

    expect(requests[0]).toEqual(["whisper-cli", "--version"]);
    expect(requests[1]).toEqual(
      expect.arrayContaining([
        "whisper-cli",
        "-m",
        modelPath,
        "-f",
        inputPath,
        "-l",
        "en",
        "-t",
        "6",
        "-oj",
        "-np",
      ]),
    );
    expect(result).toMatchObject({
      outcome: "ok",
      engineVersion: "1.9.2",
      model: { name: "large-v3-turbo" },
      segmentRangeSeconds: [0, 4],
      segmentCount: 2,
    });
    if (result.outcome !== "ok") throw new Error("expected transcription success");
    const transcript = JSON.parse(await readFile(result.transcript.path, "utf8"));
    expect(transcript).toMatchObject({
      engine: "whisper.cpp",
      engineVersion: "1.9.2",
      source: { path: inputPath, sha256 },
      model: { path: modelPath, name: "large-v3-turbo" },
      segments: [
        { start: 0, end: 2, text: "First segment." },
        { start: 2, end: 4, text: "Second segment." },
      ],
    });
    expect(await readdir(result.transcript.path.replace(/\/transcript\.json$/, ""))).toEqual([
      "transcript.json",
    ]);
  });

  it("keeps timeout distinct and removes partial output", async () => {
    const { inputPath, modelPath, sha256, root } = await fixture();
    let calls = 0;
    const result = await transcribeWithWhisper({
      inputPath,
      expectedSha256: sha256,
      artifactsDirectory: join(root, "artifacts"),
      modelPath,
      exec: async () => {
        calls++;
        return calls === 1
          ? { outcome: "ok", exitCode: 0, stdout: "whisper.cpp version: 1.9.2", stderr: "" }
          : { outcome: "timeout", exitCode: 143, stdout: "", stderr: "" };
      },
    });

    expect(result.outcome).toBe("timeout");
    expect(await readdir(join(root, "artifacts"))).toEqual([]);
  });
});
