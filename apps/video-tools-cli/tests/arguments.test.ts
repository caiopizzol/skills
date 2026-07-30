import { describe, expect, it } from "vite-plus/test";
import { parseArguments, parsePinnedImage } from "../src/arguments.ts";

const digest = "a".repeat(64);

describe("parseArguments", () => {
  it("parses a bounded container preparation", () => {
    expect(
      parseArguments([
        "prepare",
        "fixture.mp4",
        "--artifacts-dir",
        "artifacts",
        "--max-frames",
        "4",
        "--frame-count",
        "6",
        "--timeout-ms",
        "5000",
        "--container-image",
        `example/ffmpeg@sha256:${digest}`,
      ]),
    ).toEqual({
      command: "prepare",
      inputPath: "fixture.mp4",
      artifactsDirectory: "artifacts",
      maxFrames: 4,
      frameCount: 6,
      timeoutMs: 5000,
      containerImage: `example/ffmpeg@sha256:${digest}`,
    });
  });

  it("allows the tool to create a temporary artifacts directory", () => {
    expect(parseArguments(["prepare", "fixture.mp4"])).toEqual({
      command: "prepare",
      inputPath: "fixture.mp4",
    });
  });
});

describe("parsePinnedImage", () => {
  it("refuses mutable tags and bare image IDs", () => {
    expect(() => parsePinnedImage("example/ffmpeg:latest")).toThrow("digest-pinned");
    expect(() => parsePinnedImage(`sha256:${digest}`)).toThrow("digest-pinned");
  });
});
