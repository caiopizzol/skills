import { describe, expect, it } from "vite-plus/test";
import type { ExecResult } from "../src/index.ts";
import { FFPROBE_COMMAND, buildProbeArgs, parseProbeOutput, probeVideo } from "../src/index.ts";
import {
  CWD,
  INPUT_PATH,
  fakeExec,
  failed,
  missingBinary,
  ok,
  readProbeFixture,
  readVideoManifest,
} from "./fixtures/video-scenarios.ts";

const manifest = readVideoManifest();

function manifestEntry(filename: string) {
  const entry = manifest.fixtures.find((fixture) => fixture.filename === filename);
  if (!entry) throw new Error(`missing manifest entry: ${filename}`);
  return entry;
}

describe("parseProbeOutput", () => {
  it("reads the mp4 fixture as h264 video plus aac audio at 640x360 and 6 seconds", () => {
    const probe = parseProbeOutput(readProbeFixture("mp4"));
    const expected = manifestEntry("fixture-mp4.mp4");

    expect(probe.formatName).toBe("mov,mp4,m4a,3gp,3g2,mj2");
    expect(probe.containers).toContain(expected.container);
    expect(probe.durationSeconds).toBe(expected.durationSeconds);
    expect(probe.hasVideoStream).toBe(true);
    expect(probe.hasAudioStream).toBe(true);
    expect(probe.streams).toEqual([
      {
        index: 0,
        codecType: "video",
        codecName: expected.videoCodec,
        width: expected.width,
        height: expected.height,
        channels: null,
      },
      {
        index: 1,
        codecType: "audio",
        codecName: expected.audioCodec,
        width: null,
        height: null,
        channels: 1,
      },
    ]);
  });

  it("reads the mov fixture as h264 video plus aac audio at 640x360 and 6 seconds", () => {
    const probe = parseProbeOutput(readProbeFixture("mov"));
    const expected = manifestEntry("fixture-mov.mov");

    expect(probe.containers).toContain(expected.container);
    expect(probe.durationSeconds).toBe(expected.durationSeconds);
    expect(probe.streams).toEqual([
      {
        index: 0,
        codecType: "video",
        codecName: expected.videoCodec,
        width: expected.width,
        height: expected.height,
        channels: null,
      },
      {
        index: 1,
        codecType: "audio",
        codecName: expected.audioCodec,
        width: null,
        height: null,
        channels: 1,
      },
    ]);
  });

  it("reads the webm fixture as vp9 video plus opus audio at 640x360 and 6.008 seconds", () => {
    const probe = parseProbeOutput(readProbeFixture("webm"));
    const expected = manifestEntry("fixture-webm.webm");

    expect(probe.formatName).toBe("matroska,webm");
    expect(probe.containers).toContain(expected.container);
    expect(probe.durationSeconds).toBe(6.008);
    expect(probe.durationSeconds).toBe(expected.durationSeconds);
    expect(probe.streams).toEqual([
      {
        index: 0,
        codecType: "video",
        codecName: expected.videoCodec,
        width: expected.width,
        height: expected.height,
        channels: null,
      },
      {
        index: 1,
        codecType: "audio",
        codecName: expected.audioCodec,
        width: null,
        height: null,
        channels: 1,
      },
    ]);
  });

  it("rejects malformed and empty output rather than reporting an empty probe", () => {
    expect(() => parseProbeOutput("{not json")).toThrow(/invalid JSON/);
    expect(() => parseProbeOutput("")).toThrow(/no output/);
    expect(() => parseProbeOutput(JSON.stringify({ streams: [] }))).toThrow(/format object/);
    expect(() =>
      parseProbeOutput(JSON.stringify({ format: { format_name: "mp4" }, streams: [] })),
    ).toThrow(/duration/);
  });
});

describe("probeVideo", () => {
  it("builds an ffprobe argv that asks for JSON format and stream data", async () => {
    const boundary = fakeExec(() => ok(readProbeFixture("mp4")));

    const result = await probeVideo({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("ok");
    expect(boundary.requests).toEqual([
      {
        command: FFPROBE_COMMAND,
        args: buildProbeArgs(INPUT_PATH),
        cwd: CWD,
        timeoutMs: 60_000,
      },
    ]);
    expect(boundary.requests[0]?.args).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-i",
      INPUT_PATH,
    ]);
  });

  it("classifies a missing ffprobe binary as tool-unavailable", async () => {
    const boundary = fakeExec(() => {
      throw missingBinary(FFPROBE_COMMAND);
    });

    const result = await probeVideo({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("tool-unavailable");
    expect(result).not.toHaveProperty("probe");
  });

  it("classifies a shell-style 127 exit as tool-unavailable rather than a probe failure", async () => {
    const boundary = fakeExec(() => failed("ffprobe: command not found", 127));

    const result = await probeVideo({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("tool-unavailable");
  });

  it("classifies a non-zero exit as probe-failed and keeps the stderr detail", async () => {
    const boundary = fakeExec(() => failed("moov atom not found"));

    const result = await probeVideo({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("probe-failed");
    expect(result).toMatchObject({ message: expect.stringContaining("moov atom not found") });
  });

  it("classifies malformed JSON on a clean exit as probe-failed", async () => {
    const boundary = fakeExec(() => ok('{"streams": ['));

    const result = await probeVideo({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("probe-failed");
  });

  it("classifies empty output on a clean exit as probe-failed rather than success", async () => {
    const boundary = fakeExec(() => ok("   "));

    const result = await probeVideo({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("probe-failed");
    expect(result).toMatchObject({ message: expect.stringContaining("no output") });
  });

  it("classifies an exceeded deadline as timeout", async () => {
    const boundary = fakeExec(
      async () =>
        // A real boundary kills the process on its own deadline and then settles. Never
        // settling would not exercise the wait that stops cleanup racing a live writer.
        new Promise<ExecResult>((settle) => {
          setTimeout(() => settle({ exitCode: 143, stdout: "", stderr: "killed" }), 40);
        }),
    );

    const result = await probeVideo({
      inputPath: INPUT_PATH,
      cwd: CWD,
      timeoutMs: 5,
      exec: boundary.exec,
    });

    expect(result.outcome).toBe("timeout");
    expect(result).not.toHaveProperty("probe");
  });

  it("classifies a file with no video stream as unsupported-input", async () => {
    const audioOnly = JSON.stringify({
      format: { format_name: "wav", duration: "6.000000" },
      streams: [{ index: 0, codec_type: "audio", codec_name: "pcm_s16le", channels: 1 }],
    });
    const boundary = fakeExec(() => ok(audioOnly));

    const result = await probeVideo({ inputPath: INPUT_PATH, cwd: CWD, exec: boundary.exec });

    expect(result.outcome).toBe("unsupported-input");
  });
});
