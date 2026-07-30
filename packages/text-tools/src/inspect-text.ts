import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";
import {
  TEXT_TOOLS_FORMAT_VERSION,
  type FormatClassification,
  type TextCoverage,
  type TextEncoding,
  type TextFormat,
  type TextInspectionResult,
  type TextRange,
  type TextSection,
  type TextStructure,
} from "./types.ts";

export const DEFAULT_MAXIMUM_CHARACTERS = 100_000;

export interface InspectTextOptions {
  inputPath: string;
  bytes: Uint8Array;
  cwd: string;
  maximumCharacters?: number;
}

export function inspectText(options: InspectTextOptions): TextInspectionResult {
  const inputPath = resolve(options.cwd, options.inputPath);
  const byteCount = options.bytes.byteLength;
  const sha256 = createHash("sha256").update(options.bytes).digest("hex");
  const maximumCharacters = options.maximumCharacters ?? DEFAULT_MAXIMUM_CHARACTERS;
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters <= 0) {
    throw new Error("maximumCharacters must be a positive integer");
  }

  let decoded: { encoding: TextEncoding; text: string };
  try {
    decoded = decodeText(options.bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      formatVersion: TEXT_TOOLS_FORMAT_VERSION,
      outcome: /encoding/i.test(message) ? "unsupported-encoding" : "invalid-text",
      inputPath,
      bytes: byteCount,
      sha256,
      message,
    };
  }

  const normalized = decoded.text.replace(/\r\n?/g, "\n");
  const { format, classification } = detectTextFormat(inputPath, normalized);
  // Decoding succeeded, so the text is readable evidence no matter what the structure lane finds.
  // A failed parse is recorded as a structure gap rather than throwing the contents away: the
  // caller asked to read a file, and "this is not valid JSON" is not a reason to withhold it.
  let structure: TextStructure;
  let parseFailure: string | null = null;
  try {
    structure = inspectStructure(format, normalized);
  } catch (error) {
    parseFailure = error instanceof Error ? error.message : String(error);
    structure = { kind: "parse-failed", reason: parseFailure };
  }
  const { coverage, sections } = selectTextSections(normalized, maximumCharacters);
  return {
    formatVersion: TEXT_TOOLS_FORMAT_VERSION,
    outcome: parseFailure === null ? "ok" : "parse-failed",
    inputPath,
    bytes: byteCount,
    sha256,
    encoding: decoded.encoding,
    newlineNormalization: normalized === decoded.text ? "none" : "crlf-or-cr-to-lf",
    format,
    formatClassification: classification,
    structure,
    coverage,
    sections,
  };
}

export function decodeText(bytes: Uint8Array): { encoding: TextEncoding; text: string } {
  let encoding: TextEncoding = "utf-8";
  let body = bytes;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    body = bytes.subarray(3);
  } else if (startsWith(bytes, [0xff, 0xfe])) {
    encoding = "utf-16le";
    body = bytes.subarray(2);
  } else if (startsWith(bytes, [0xfe, 0xff])) {
    encoding = "utf-16be";
    body = swapBytePairs(bytes.subarray(2));
  }
  if (body.byteLength % 2 !== 0 && encoding !== "utf-8") {
    throw new Error(`unsupported encoding: ${encoding} input has an incomplete code unit`);
  }
  let text: string;
  try {
    text = new TextDecoder(encoding === "utf-8" ? "utf-8" : "utf-16le", { fatal: true }).decode(
      body,
    );
  } catch {
    throw new Error(`unsupported encoding: input is not valid ${encoding} text`);
  }
  if (containsBinaryControlCharacter(text)) {
    throw new Error("invalid text: decoded input contains binary control characters");
  }
  return { encoding, text };
}

export function detectTextFormat(
  inputPath: string,
  text: string,
): { format: TextFormat; classification: FormatClassification } {
  const extension = extname(inputPath).toLowerCase();
  // An extension is the caller's claim about the file. Keeping it apart from a content guess lets a
  // parse failure say whether the file broke its own promise or this tool guessed wrong.
  if (extension === ".json") return { format: "json", classification: "declared" };
  if (extension === ".xml") return { format: "xml", classification: "declared" };
  if (extension === ".csv") return { format: "csv", classification: "declared" };
  if (extension === ".md" || extension === ".markdown")
    return { format: "markdown", classification: "declared" };
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    return { format: "json", classification: "inferred" };
  if (/^<\?xml\b|^<[a-z_][\w:.-]*(?:\s|>)/i.test(trimmed))
    return { format: "xml", classification: "inferred" };
  if (/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```)/m.test(text))
    return { format: "markdown", classification: "inferred" };
  if (looksLikeCsv(text)) return { format: "csv", classification: "inferred" };
  return { format: "plain", classification: "inferred" };
}

export function selectTextSections(
  text: string,
  maximumCharacters: number,
): {
  coverage: TextCoverage;
  sections: TextSection[];
} {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters <= 0) {
    throw new Error("maximumCharacters must be a positive integer");
  }
  const characters = Array.from(text);
  const totalCharacters = characters.length;
  const totalLines = countLines(text);
  const retainedRanges: TextRange[] =
    totalCharacters === 0
      ? []
      : totalCharacters <= maximumCharacters
        ? [{ startCharacter: 0, endCharacter: totalCharacters }]
        : splitRanges(totalCharacters, maximumCharacters);
  const omittedRanges = invertRanges(totalCharacters, retainedRanges);
  const sections = retainedRanges.map((range) => {
    const prefix = characters.slice(0, range.startCharacter).join("");
    const sectionText = characters.slice(range.startCharacter, range.endCharacter).join("");
    const startLine = countNewlines(prefix) + 1;
    return {
      ...range,
      startLine,
      endLine: startLine + countNewlines(sectionText) - (sectionText.endsWith("\n") ? 1 : 0),
      text: sectionText,
    };
  });
  return {
    coverage: {
      totalCharacters,
      totalLines,
      maximumCharacters,
      boundedBy: omittedRanges.length === 0 ? "complete" : "maximum-characters",
      retainedRanges,
      omittedRanges,
    },
    sections,
  };
}

function inspectStructure(format: TextFormat, text: string): TextStructure {
  if (format === "json") {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(
        `JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (Array.isArray(value)) return { kind: "json", rootType: "array", topLevelKeys: [] };
    if (typeof value === "object" && value !== null) {
      return { kind: "json", rootType: "object", topLevelKeys: Object.keys(value).sort() };
    }
    return { kind: "json", rootType: "scalar", topLevelKeys: [] };
  }
  if (format === "csv") {
    const rows = parseCsv(text);
    const headers = rows[0];
    if (headers === undefined || headers.every((header) => header === "")) {
      throw new Error("CSV parsing failed: missing header row");
    }
    for (const [index, row] of rows.entries()) {
      if (row.length !== headers.length) {
        throw new Error(
          `CSV parsing failed: row ${index + 1} has ${row.length} columns, expected ${headers.length}`,
        );
      }
    }
    return {
      kind: "csv",
      headers,
      rowCount: Math.max(0, rows.length - 1),
      columnCount: headers.length,
    };
  }
  if (format === "xml") {
    return {
      kind: "unvalidated",
      reason: "XML was identified but no XML parser validated its structure",
    };
  }
  return null;
}

function containsBinaryControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x08 || (code >= 0x0b && code <= 0x0c) || (code >= 0x0e && code <= 0x1f)) {
      return true;
    }
  }
  return false;
}

export function parseCsv(text: string): string[][] {
  if (text === "") return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
        afterQuote = true;
      } else {
        field += character;
      }
    } else if (afterQuote) {
      if (character === ",") {
        row.push(field);
        field = "";
        afterQuote = false;
      } else if (character === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        afterQuote = false;
      } else {
        throw new Error("CSV parsing failed: unexpected content after a closing quote");
      }
    } else if (character === '"') {
      if (field !== "")
        throw new Error("CSV parsing failed: quote begins inside an unquoted field");
      inQuotes = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (inQuotes) throw new Error("CSV parsing failed: unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function looksLikeCsv(text: string): boolean {
  try {
    const rows = parseCsv(text).slice(0, 3);
    return (
      rows.length >= 2 &&
      (rows[0]?.length ?? 0) > 1 &&
      rows.every((row) => row.length === rows[0]?.length)
    );
  } catch {
    return false;
  }
}

function splitRanges(totalCharacters: number, maximumCharacters: number): TextRange[] {
  const head = Math.ceil(maximumCharacters / 2);
  const tail = maximumCharacters - head;
  if (tail === 0) return [{ startCharacter: 0, endCharacter: head }];
  return [
    { startCharacter: 0, endCharacter: head },
    { startCharacter: totalCharacters - tail, endCharacter: totalCharacters },
  ];
}

function invertRanges(totalCharacters: number, retained: readonly TextRange[]): TextRange[] {
  const omitted: TextRange[] = [];
  let cursor = 0;
  for (const range of retained) {
    if (range.startCharacter > cursor)
      omitted.push({ startCharacter: cursor, endCharacter: range.startCharacter });
    cursor = range.endCharacter;
  }
  if (cursor < totalCharacters)
    omitted.push({ startCharacter: cursor, endCharacter: totalCharacters });
  return omitted;
}

function countLines(text: string): number {
  return text === "" ? 0 : countNewlines(text) + (text.endsWith("\n") ? 0 : 1);
}

function countNewlines(text: string): number {
  return text.match(/\n/g)?.length ?? 0;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function swapBytePairs(bytes: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(bytes.byteLength);
  for (let index = 0; index < bytes.byteLength; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0;
    swapped[index + 1] = bytes[index] ?? 0;
  }
  return swapped;
}
