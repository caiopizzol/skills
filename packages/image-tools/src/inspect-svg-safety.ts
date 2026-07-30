import { Buffer } from "node:buffer";
import { resolvePath } from "@caiopizzol/media-exec";
import {
  IMAGE_TOOLS_FORMAT_VERSION,
  type InspectSvgSafetyResult,
  type SvgSafetyReason,
  type SvgSafetyVerdict,
} from "./types.ts";

export interface InspectSvgSafetyOptions {
  inputPath: string;
  source: string;
  cwd: string;
}

// An SVG is a document, not a picture. Rasterizing one asks the renderer to execute whatever the
// document describes, which can include fetching a remote resource, resolving an entity, or running
// script. This inspection runs before any rasterizer sees the file, so an unsafe SVG is refused
// rather than rendered and then regretted.
//
// The check is textual and deliberately over-eager. A construct that only looks dangerous is still
// reported, because a false refusal costs a reading and a false acceptance costs a request the
// caller never authorized. It is not a sanitizer: nothing here rewrites the file.
//
// Patterns run against a decoded copy of the source. A renderer resolves character references
// before it interprets markup, so scanning raw text lets `&#117;rl(...)` slip past a `url(` pattern
// while still fetching when drawn. Decoding first removes that whole class of bypass.
const NAMESPACE_PREFIX = "(?:[^\\s/>=\"'()]+:)?";
const MAX_NESTED_SVG_DATA_URLS = 4;
const SAFE_RASTER_DATA_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

function decodeCharacterReferences(source: string): string {
  return source
    .replace(/&#x([0-9a-f]+);?/gi, (whole, hex: string) => codePoint(parseInt(hex, 16), whole))
    .replace(/&#(\d+);?/g, (whole, digits: string) => codePoint(Number(digits), whole));
}

function codePoint(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

// A data: URL is self-contained only if its payload is. An SVG carried inside one is markup the
// renderer parses, so it is inspected rather than trusted for being inline.
function isSafeInlineData(target: string | undefined, depth: number): boolean {
  if (!/^\s*data:/i.test(target ?? "")) return false;
  const value = target ?? "";
  const comma = value.indexOf(",");
  if (comma < 0) return false;
  const metadata = value.slice(value.indexOf(":") + 1, comma);
  const [mediaType = "", ...parameters] = metadata.split(";");
  const normalizedMediaType = mediaType.trim().toLowerCase();
  if (SAFE_RASTER_DATA_MEDIA_TYPES.has(normalizedMediaType)) return true;
  if (normalizedMediaType !== "image/svg+xml" || depth >= MAX_NESTED_SVG_DATA_URLS) return false;
  let payload = value.slice(comma + 1);
  try {
    if (parameters.some((parameter) => parameter.trim().toLowerCase() === "base64")) {
      if (!/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(payload)) return false;
      payload = Buffer.from(payload, "base64").toString("utf8");
    } else {
      payload = decodeURIComponent(payload);
    }
  } catch {
    return false;
  }
  return inspectSvgTextAtDepth(payload, depth + 1).selfContained;
}

const CHECKS: ReadonlyArray<{
  code: SvgSafetyReason["code"];
  pattern: RegExp;
  describe: (match: RegExpExecArray) => string;
  // A check that can match a construct which is still self-contained supplies this. Reportability
  // belongs to the check rather than the code, because two checks can share a code and read
  // different capture groups.
  isReportable?: (match: RegExpExecArray, depth: number) => boolean;
}> = [
  {
    code: "script-element",
    pattern: new RegExp(`<\\s*${NAMESPACE_PREFIX}script\\b`, "gi"),
    describe: () => "a script element can run code in the renderer",
  },
  {
    code: "external-reference",
    pattern: new RegExp(`<\\s*${NAMESPACE_PREFIX}style\\b|\\sstyle\\s*=\\s*["']`, "gi"),
    describe: () => "style content is refused because CSS escapes can conceal external references",
  },
  {
    code: "external-reference",
    pattern: /<\?xml-stylesheet\b/gi,
    describe: () => "an XML stylesheet instruction can fetch content outside the file",
  },
  {
    code: "foreign-object",
    pattern: new RegExp(`<\\s*${NAMESPACE_PREFIX}foreignObject\\b`, "gi"),
    describe: () => "a foreignObject element embeds non-SVG content the renderer parses separately",
  },
  {
    code: "entity-declaration",
    pattern: /<!ENTITY\b|<!DOCTYPE[^>[]*\b(?:SYSTEM|PUBLIC)\b/gi,
    describe: (match) => `an entity declaration can pull in outside content: ${snippet(match[0])}`,
  },
  {
    code: "external-image",
    pattern: new RegExp(
      `<\\s*${NAMESPACE_PREFIX}image\\b[^>]*?\\b${NAMESPACE_PREFIX}href\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
      "gi",
    ),
    describe: (match) => `an image element points outside the file: ${snippet(match[2] ?? "")}`,
    // Only an inline data: target keeps an image element self-contained, and only when its own
    // payload is self-contained. A fragment reference names nothing a raster image can come from,
    // so it is reported too rather than treated as internal.
    isReportable: (match, depth) => !isSafeInlineData(match[2], depth),
  },
  {
    code: "external-reference",
    pattern: new RegExp(`\\b${NAMESPACE_PREFIX}href\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "gi"),
    describe: (match) => `a reference points outside the file: ${snippet(match[2] ?? "")}`,
    isReportable: (match, depth) => !isInternalTarget(match[2], depth),
  },
  {
    code: "external-reference",
    pattern: /\burl\(\s*(["']?)([^)"']*)\1\s*\)/gi,
    describe: (match) => `a url() reference points outside the file: ${snippet(match[2] ?? "")}`,
    isReportable: (match, depth) => !isInternalTarget(match[2], depth),
  },
  {
    code: "external-reference",
    // A stylesheet import is a fetch the renderer performs before it draws anything, and the target
    // can be a bare quoted string rather than a url(), which the rule above does not see. Every
    // @import is reported, including one whose target looks harmless: a self-contained file has no
    // reason to import a stylesheet at all.
    pattern: /@import\b[^;}]*/gi,
    describe: (match) =>
      `an @import rule fetches a stylesheet from outside the file: ${snippet(match[0])}`,
  },
  {
    code: "event-handler-attribute",
    pattern: /\son[a-z]+\s*=\s*["']/gi,
    describe: (match) =>
      `an event handler attribute can run code in the renderer: ${snippet(match[0].trim())}`,
  },
];

export function inspectSvgText(source: string): SvgSafetyVerdict {
  return inspectSvgTextAtDepth(source, 0);
}

function inspectSvgTextAtDepth(source: string, depth: number): SvgSafetyVerdict {
  const reasons: SvgSafetyReason[] = [];
  // A renderer decodes character references before interpreting markup, so the checks run against a
  // decoded copy. The original is never rewritten; this copy exists only to be scanned.
  const decoded = decodeCharacterReferences(source);
  for (const check of CHECKS) {
    // Nested SVG data URLs are inspected recursively. Use a local matcher so an inner inspection
    // cannot reset the outer matcher's lastIndex and make it revisit the same reference forever.
    const pattern = new RegExp(check.pattern.source, check.pattern.flags);
    let match = pattern.exec(decoded);
    while (match !== null) {
      if (check.isReportable?.(match, depth) ?? true) {
        reasons.push({ code: check.code, detail: check.describe(match) });
      }
      match = pattern.exec(decoded);
    }
  }
  return {
    formatVersion: IMAGE_TOOLS_FORMAT_VERSION,
    selfContained: reasons.length === 0,
    reasons,
  };
}

export function inspectSvgSafety(options: InspectSvgSafetyOptions): InspectSvgSafetyResult {
  const verdict = inspectSvgText(options.source);
  return {
    outcome: verdict.selfContained ? "ok" : "unsafe-input",
    operation: "inspect-svg",
    inputPath: resolvePath(options.inputPath, options.cwd),
    verdict,
  };
}

// A same-document fragment resolves inside the file the renderer already has, and an inline data
// URL carries its own bytes. Everything else is a fetch.
function isInternalTarget(target: string | undefined, depth: number): boolean {
  const value = (target ?? "").trim();
  return value === "" || value.startsWith("#") || isSafeInlineData(target, depth);
}

function snippet(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 77)}...`;
}
