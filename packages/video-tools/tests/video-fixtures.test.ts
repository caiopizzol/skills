import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

interface VideoFixtureManifest {
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

const fixtureDirectory = join(import.meta.dirname, "fixtures", "videos");
const manifest = JSON.parse(
  readFileSync(join(fixtureDirectory, "manifest.json"), "utf8"),
) as VideoFixtureManifest;
const expectedMatrix = [
  ["fixture-mp4.mp4", "video/mp4", "h264", "aac"],
  ["fixture-mov.mov", "video/quicktime", "h264", "aac"],
  ["fixture-webm.webm", "video/webm", "vp9", "opus"],
] as const;

describe("video fixtures", () => {
  it("keeps the supported matrix explicit", () => {
    expect(
      manifest.fixtures.map(({ filename, mediaType, videoCodec, audioCodec }) => [
        filename,
        mediaType,
        videoCodec,
        audioCodec,
      ]),
    ).toEqual(expectedMatrix);
  });

  it.each(manifest.fixtures)(
    "recognizes $filename from canonical bytes",
    ({ filename, bytes, sha256 }) => {
      const fixture = readFileSync(join(fixtureDirectory, filename));
      expect(fixture.byteLength).toBe(bytes);
      expect(createHash("sha256").update(fixture).digest("hex")).toBe(sha256);
    },
  );

  it.each(manifest.fixtures)(
    "records temporal, visual, and audio expectations for $filename",
    (fixture) => {
      expect(fixture.durationSeconds).toBeGreaterThan(0);
      expect(fixture.width).toBe(640);
      expect(fixture.height).toBe(360);
      expect(fixture.sampleTimesSeconds).toEqual([1, 3, 5]);
      expect(fixture.expectedText).toHaveLength(3);
      expect(fixture.expectedShapes).toHaveLength(3);
      expect(fixture.expectedTranscript.length).toBeGreaterThan(0);
    },
  );
});
