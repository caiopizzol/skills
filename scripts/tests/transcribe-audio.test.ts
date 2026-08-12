import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { transcribeWithGroq } from "../../skills/files/transcribe-audio/scripts/transcribe-groq.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(
  extension = "wav",
): Promise<{ inputPath: string; sha256: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "transcribe-audio-"));
  temporary.push(root);
  const inputPath = join(root, `audio.${extension}`);
  const bytes = Buffer.from("audio bytes");
  await writeFile(inputPath, bytes);
  return {
    inputPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    root,
  };
}

function groqResponse(): Response {
  return Response.json({
    text: "First segment. Second segment.",
    language: "en",
    duration: 4,
    segments: [
      { start: 0, end: 2, text: "First segment." },
      { start: 2, end: 4, text: "Second segment." },
    ],
  });
}

describe("Groq audio transcription", () => {
  it("requires explicit authorization before reading credentials or calling Groq", async () => {
    const { inputPath, sha256, root } = await fixture();
    let called = false;

    const result = await transcribeWithGroq({
      inputPath,
      expectedSha256: sha256,
      artifactsDirectory: join(root, "artifacts"),
      allowHosted: false,
      apiKey: "test-key",
      fetcher: async () => {
        called = true;
        return groqResponse();
      },
    });

    expect(result.outcome).toBe("access-denied");
    expect(called).toBe(false);
  });

  it("stops on a source hash mismatch before creating artifacts or calling Groq", async () => {
    const { inputPath, root } = await fixture();
    const artifactsDirectory = join(root, "artifacts");
    let called = false;

    const result = await transcribeWithGroq({
      inputPath,
      expectedSha256: "a".repeat(64),
      artifactsDirectory,
      allowHosted: true,
      apiKey: "test-key",
      fetcher: async () => {
        called = true;
        return groqResponse();
      },
    });

    expect(result.outcome).toBe("input-changed");
    expect(called).toBe(false);
    expect(await readdir(artifactsDirectory).catch(() => [])).toEqual([]);
  });

  it("requests segment timestamps and writes a source-bound transcript", async () => {
    const { inputPath, sha256, root } = await fixture("mp3");
    const artifactsDirectory = join(root, "artifacts");

    const result = await transcribeWithGroq({
      inputPath,
      expectedSha256: sha256,
      artifactsDirectory,
      allowHosted: true,
      apiKey: "test-key",
      fetcher: async (input, init) => {
        expect(input).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
        expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
        const body = init?.body;
        if (!(body instanceof FormData)) throw new Error("expected multipart form data");
        expect(body.get("model")).toBe("whisper-large-v3-turbo");
        expect(body.get("response_format")).toBe("verbose_json");
        expect(body.get("timestamp_granularities[]")).toBe("segment");
        return groqResponse();
      },
    });

    expect(result).toMatchObject({
      outcome: "ok",
      coverage: { processedRangeSeconds: [0, 4], segmentCount: 2 },
    });
    if (result.outcome !== "ok") throw new Error("expected transcription success");
    const transcript = JSON.parse(await readFile(result.transcript.path, "utf8"));
    expect(transcript).toMatchObject({
      provider: "Groq",
      model: "whisper-large-v3-turbo",
      source: { path: inputPath, sha256 },
      segments: [
        { start: 0, end: 2, text: "First segment." },
        { start: 2, end: 4, text: "Second segment." },
      ],
    });
  });

  it("refuses an oversized input before calling Groq", async () => {
    const { inputPath, sha256, root } = await fixture("raw");
    let called = false;

    const result = await transcribeWithGroq({
      inputPath,
      expectedSha256: sha256,
      artifactsDirectory: join(root, "artifacts"),
      allowHosted: true,
      apiKey: "test-key",
      maxUploadBytes: 4,
      fetcher: async () => {
        called = true;
        return groqResponse();
      },
    });

    expect(result).toMatchObject({ outcome: "unsupported-input" });
    expect(called).toBe(false);
    expect(await readdir(join(root, "artifacts")).catch(() => [])).toEqual([]);
  });
});
