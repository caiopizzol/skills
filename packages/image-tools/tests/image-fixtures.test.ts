import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { readImageFixture, readImageManifest } from "./fixtures/image-scenarios.ts";

const manifest = readImageManifest();
const expectedMatrix = [
  ["fixture-png.png", "image/png", 1],
  ["fixture-jpeg.jpg", "image/jpeg", 1],
  ["fixture-webp.webp", "image/webp", 1],
  ["fixture-avif.avif", "image/avif", 1],
  ["fixture-heic.heic", "image/heic", 1],
  ["fixture-tiff.tiff", "image/tiff", 1],
  ["fixture-bmp.bmp", "image/bmp", 1],
  ["fixture-svg.svg", "image/svg+xml", 1],
  ["fixture-animated.gif", "image/gif", 3],
] as const;

describe("image fixtures", () => {
  it("keeps the complete image matrix and structural expectations explicit", () => {
    expect(
      manifest.fixtures.map(({ filename, mediaType, frameCount }) => [
        filename,
        mediaType,
        frameCount,
      ]),
    ).toEqual(expectedMatrix);
    for (const fixture of manifest.fixtures) {
      expect(fixture.expectedText.length).toBeGreaterThan(0);
      expect(fixture.expectedColors.length).toBeGreaterThan(0);
      expect(fixture.expectedShapes.length).toBeGreaterThan(0);
    }
  });

  it.each(manifest.fixtures)(
    "recognizes $filename from canonical bytes",
    ({ filename, bytes, sha256 }) => {
      const fixture = readImageFixture(filename);
      expect(fixture.byteLength).toBe(bytes);
      expect(createHash("sha256").update(fixture).digest("hex")).toBe(sha256);
    },
  );

  it("contains a static WebP and a three-frame GIF", () => {
    const webp = readImageFixture("fixture-webp.webp");
    const gif = readImageFixture("fixture-animated.gif");
    expect(Buffer.from(webp).includes(Buffer.from("ANIM"))).toBe(false);
    expect(countGifFrames(gif)).toBe(3);
  });
});

function countGifFrames(bytes: Uint8Array): number {
  if (!new TextDecoder().decode(bytes.slice(0, 6)).startsWith("GIF8"))
    throw new Error("Invalid GIF header");
  let offset = 13;
  const globalColorTable = bytes[10] ?? 0;
  if ((globalColorTable & 0x80) !== 0) offset += 3 * (1 << ((globalColorTable & 0x07) + 1));

  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) return frames;
    if (marker === 0x21) {
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) throw new Error("Invalid GIF block");
    frames += 1;
    const localColorTable = bytes[offset + 8] ?? 0;
    offset += 9;
    if ((localColorTable & 0x80) !== 0) offset += 3 * (1 << ((localColorTable & 0x07) + 1));
    offset += 1;
    offset = skipGifSubBlocks(bytes, offset);
  }
  throw new Error("GIF trailer not found");
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset++] ?? 0;
    if (size === 0) return offset;
    offset += size;
  }
  throw new Error("Truncated GIF sub-block");
}
