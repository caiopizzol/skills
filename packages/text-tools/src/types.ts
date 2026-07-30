export const TEXT_TOOLS_FORMAT_VERSION = 1 as const;

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be";
export type TextFormat = "plain" | "markdown" | "json" | "xml" | "csv";
// Decoding and structural parsing are separate lanes. `parse-failed` describes the structure lane
// only: text that decoded successfully is still readable evidence, so a JSON or CSV file that does
// not parse keeps its bounded sections rather than being reported as unreadable.
export type TextOutcome = "ok" | "unsupported-encoding" | "invalid-text" | "parse-failed";

export interface TextRange {
  startCharacter: number;
  endCharacter: number;
}

export interface TextSection extends TextRange {
  startLine: number;
  endLine: number;
  text: string;
}

export interface TextCoverage {
  totalCharacters: number;
  totalLines: number;
  maximumCharacters: number;
  boundedBy: "complete" | "maximum-characters";
  retainedRanges: TextRange[];
  omittedRanges: TextRange[];
}

// Whether the format came from the caller's declaration or from a content guess. A failed guess
// and a failed declaration mean different things: one says the file is not what it claimed, the
// other says this tool guessed wrong about a file that never claimed anything.
export type FormatClassification = "declared" | "inferred";

export type TextStructure =
  | { kind: "json"; rootType: "array" | "object" | "scalar"; topLevelKeys: string[] }
  | { kind: "csv"; headers: string[]; rowCount: number; columnCount: number }
  | { kind: "unvalidated"; reason: string }
  | { kind: "parse-failed"; reason: string }
  | null;

// A decoded result. The outcome is `ok` when the structure lane also succeeded and `parse-failed`
// when it did not, but the readable content is present either way: decoding is what makes the text
// evidence, and structural validity is a separate claim about it.
export interface TextInspectionDecoded {
  formatVersion: typeof TEXT_TOOLS_FORMAT_VERSION;
  outcome: "ok" | "parse-failed";
  inputPath: string;
  bytes: number;
  sha256: string;
  encoding: TextEncoding;
  newlineNormalization: "none" | "crlf-or-cr-to-lf";
  format: TextFormat;
  formatClassification: FormatClassification;
  structure: TextStructure;
  coverage: TextCoverage;
  sections: TextSection[];
}

// Decoding itself failed, so there is no text to retain and no structure to describe.
export interface TextInspectionUndecodable {
  formatVersion: typeof TEXT_TOOLS_FORMAT_VERSION;
  outcome: "unsupported-encoding" | "invalid-text";
  inputPath: string;
  bytes: number;
  sha256: string;
  message: string;
}

export type TextInspectionResult = TextInspectionDecoded | TextInspectionUndecodable;
