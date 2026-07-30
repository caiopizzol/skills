import { IMAGE_TOOLS_FORMAT_VERSION, type InputClassification, type InputKind } from "./types.ts";

// This classifier is deliberately fallible and must never be the security guarantee.
//
// An SVG is a document, not a picture, so it has to be inspected before a rasterizer sees it. The
// question "is this file an SVG?" is answered twice: once here, and once by the renderer. The two
// answers are not required to agree, and the gap between them is where a bypass lives. The original
// implementation asked only whether the name ended in `.svg` or the bytes began with `<svg`, while
// ImageMagick sniffs an XML declaration anywhere near the head and maps `.msvg` to its own SVG
// renderer. A single comment between `<?xml?>` and `<svg` was enough to separate the two.
//
// Widening the pattern does not fix that class of defect; it only moves the boundary. So this
// classifier is conservative, scans the whole buffer rather than a prefix window, and is backed by a
// non-bypassable rule in the caller: an identification of SVG with no safety verdict is refused.
//
// Prefer a false candidate over a false pass. Classifying a PNG as a candidate costs one cheap text
// scan that finds nothing. Missing an SVG costs an unreviewed document handed to a renderer.

// Signatures for formats that are unambiguously raster containers. A file that starts with one of
// these is not an XML document, so it never needs the textual scan.
const RASTER_SIGNATURES: ReadonlyArray<{ label: string; bytes: readonly number[] }> = [
  { label: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { label: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { label: "gif87a", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { label: "gif89a", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { label: "bmp", bytes: [0x42, 0x4d] },
  { label: "tiff-le", bytes: [0x49, 0x49, 0x2a, 0x00] },
  { label: "tiff-be", bytes: [0x4d, 0x4d, 0x00, 0x2a] },
];

const GZIP_SIGNATURE = [0x1f, 0x8b] as const;

// Extensions ImageMagick maps to an SVG-family coder. `identify -list format` reports SVG, SVGZ,
// and MSVG; `.svg.gz` is the conventional spelling of a compressed SVG. This list is a shortcut for
// the common case, not the boundary: an unlisted extension still reaches the textual scan.
const SVG_EXTENSIONS = new Set([".svg", ".svgz", ".msvg", ".gz"]);

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function extensionOf(path: string): string {
  return (path.match(/\.[^./\\]+$/)?.[0] ?? "").toLowerCase();
}

export function classifyInput(inputPath: string, bytes: Uint8Array): InputClassification {
  const extension = extensionOf(inputPath);

  // Compressed content is unreadable to a textual inspector, and decompressing an untrusted archive
  // to inspect it trades one hazard for another. Refuse it as its own outcome instead: a gzipped
  // SVG rasterizes perfectly well, so silence here is not safety.
  if (startsWith(bytes, GZIP_SIGNATURE)) {
    return {
      formatVersion: IMAGE_TOOLS_FORMAT_VERSION,
      kind: "compressed-input",
      reason: "the input is gzip-compressed, so its contents cannot be inspected before rasterization",
    };
  }
  if (extension === ".svgz" || inputPath.toLowerCase().endsWith(".svg.gz")) {
    return {
      formatVersion: IMAGE_TOOLS_FORMAT_VERSION,
      kind: "compressed-input",
      reason: `${extension} names a compressed SVG, whose contents cannot be inspected before rasterization`,
    };
  }

  for (const signature of RASTER_SIGNATURES) {
    if (startsWith(bytes, signature.bytes)) {
      return { formatVersion: IMAGE_TOOLS_FORMAT_VERSION, kind: "known-raster", reason: `${signature.label} signature` };
    }
  }

  if (SVG_EXTENSIONS.has(extension)) {
    return {
      formatVersion: IMAGE_TOOLS_FORMAT_VERSION,
      kind: "textual-svg-candidate",
      reason: `${extension} names an SVG-family coder`,
    };
  }

  // Strict decoding, so a binary file is not scanned as if it were text. A decode failure does not
  // silently mean "not a candidate": if the name or the bytes still suggest XML, the caller's
  // post-identification rule remains in force and will refuse an SVG that never got a verdict.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      formatVersion: IMAGE_TOOLS_FORMAT_VERSION,
      kind: "unknown",
      reason: "the input is not valid UTF-8 text, so no textual inspection applies",
    };
  }

  // The whole buffer, not a prefix. A document can carry an arbitrarily long preamble, comment, or
  // DOCTYPE before its root element, and a window large enough today is one an author can pad past.
  if (/<svg[\s>/]/i.test(text)) {
    return { formatVersion: IMAGE_TOOLS_FORMAT_VERSION, kind: "textual-svg-candidate", reason: "the content contains an svg element" };
  }
  if (/^\s*(?:<\?xml|<!DOCTYPE|<!--|<\?)/i.test(text)) {
    return {
      formatVersion: IMAGE_TOOLS_FORMAT_VERSION,
      kind: "textual-svg-candidate",
      reason: "the content opens as an XML document, which a renderer may route to its SVG coder",
    };
  }
  return { formatVersion: IMAGE_TOOLS_FORMAT_VERSION, kind: "unknown", reason: "no raster signature and no XML or SVG indicator" };
}

export function isSvgCandidate(kind: InputKind): boolean {
  return kind === "textual-svg-candidate";
}
