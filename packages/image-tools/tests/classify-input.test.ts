import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { classifyInput, type InputKind } from "../src/index.ts";

// The classifier is deliberately fallible, and the caller's post-identification rule is what makes
// a miss survivable. That backstop also masks a regression here, so this layer is pinned on its own:
// without these, reverting the classifier to its original prefix match breaks nothing visibly while
// quietly widening how much untrusted XML reaches the renderer's parser.

const UNSAFE = '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>';
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const candidates: ReadonlyArray<{ label: string; path: string; bytes: Uint8Array }> = [
  { label: "a bare svg root", path: "a.png", bytes: encode(UNSAFE) },
  { label: "an XML declaration then a comment", path: "a.png", bytes: encode(`<?xml version="1.0"?><!-- c -->${UNSAFE}`) },
  { label: "a DOCTYPE prefix", path: "a.png", bytes: encode(`<!DOCTYPE svg PUBLIC "" "">${UNSAFE}`) },
  { label: "a comment prefix", path: "a.dat", bytes: encode(`<!-- c -->${UNSAFE}`) },
  { label: "a root padded past any prefix window", path: "a.png", bytes: encode(`<?xml version="1.0"?>${"\n".repeat(50_000)}${UNSAFE}`) },
  { label: "whitespace padding with no declaration", path: "a.png", bytes: encode(`${" ".repeat(50_000)}${UNSAFE}`) },
  { label: "the .svg extension", path: "a.svg", bytes: encode(UNSAFE) },
  { label: "the .msvg coder extension", path: "a.msvg", bytes: encode(UNSAFE) },
  { label: "an uppercase .SVG extension", path: "a.SVG", bytes: encode(UNSAFE) },
];

describe("SVG candidate classification", () => {
  it.each(candidates)("treats $label as a candidate", ({ path, bytes }) => {
    expect(classifyInput(path, bytes).kind).toBe<InputKind>("textual-svg-candidate");
  });

  it.each([
    { label: "gzip magic under any name", path: "a.png", bytes: new Uint8Array(gzipSync(Buffer.from(UNSAFE))) },
    { label: "the .svgz extension", path: "a.svgz", bytes: encode(UNSAFE) },
    { label: "the .svg.gz spelling", path: "a.svg.gz", bytes: encode(UNSAFE) },
  ])("refuses $label as compressed rather than scanning it", ({ path, bytes }) => {
    expect(classifyInput(path, bytes).kind).toBe<InputKind>("compressed-input");
  });

  // A classifier that answered "candidate" for everything would pass every case above. These are
  // what keep it from becoming that.
  it.each([
    { label: "PNG", path: "a.png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { label: "JPEG", path: "a.jpg", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]) },
    { label: "GIF", path: "a.gif", bytes: encode("GIF89a") },
    { label: "TIFF", path: "a.tiff", bytes: Uint8Array.from([0x49, 0x49, 0x2a, 0x00]) },
  ])("routes a genuine $label straight through as a raster", ({ path, bytes }) => {
    expect(classifyInput(path, bytes).kind).toBe<InputKind>("known-raster");
  });

  it("does not treat prose that merely mentions svg as a candidate", () => {
    // The trigger is an svg element, not the word. Matching the word would make every design
    // discussion a candidate without catching anything a renderer would parse.
    expect(classifyInput("notes.txt", encode("a plain sentence about an svg file")).kind).toBe<InputKind>("unknown");
    expect(classifyInput("notes.txt", encode("a plain sentence with no markup at all")).kind).toBe<InputKind>("unknown");
  });

  it("reports undecodable bytes as unknown instead of scanning them as text", () => {
    expect(classifyInput("a.bin", Uint8Array.from([0x00, 0xff, 0xfe, 0x01])).kind).toBe<InputKind>("unknown");
  });

  it("explains every decision so a reader can judge the routing", () => {
    for (const { path, bytes } of candidates) {
      expect(classifyInput(path, bytes).reason.length).toBeGreaterThan(0);
    }
  });
});
