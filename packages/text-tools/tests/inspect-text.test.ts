import { describe, expect, it } from "vite-plus/test";
import {
  decodeText,
  detectTextFormat,
  inspectText,
  parseCsv,
  selectTextSections,
} from "../src/index.ts";

const CWD = "/fixture/run";

describe("decodeText", () => {
  it("decodes UTF-8 and BOM-declared UTF-16 without guessing an unmarked encoding", () => {
    expect(decodeText(new TextEncoder().encode("hello")).text).toBe("hello");
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toEqual({
      encoding: "utf-16le",
      text: "hi",
    });
    expect(decodeText(Uint8Array.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))).toEqual({
      encoding: "utf-16be",
      text: "hi",
    });
  });

  it("refuses invalid UTF-8 and decoded binary controls", () => {
    expect(
      inspectText({ inputPath: "bad.txt", bytes: Uint8Array.from([0xc3, 0x28]), cwd: CWD }).outcome,
    ).toBe("unsupported-encoding");
    expect(
      inspectText({ inputPath: "binary.txt", bytes: Uint8Array.from([0x61, 0x00, 0x62]), cwd: CWD })
        .outcome,
    ).toBe("invalid-text");
  });
});

describe("structured formats", () => {
  // A file that breaks its own declared structure keeps the failure visible. It also keeps its
  // contents: decoding succeeded, so the text is still readable evidence the caller asked for.
  it("records a declared structure failure without discarding the decoded text", () => {
    const badJson = inspectText({
      inputPath: "claim.json",
      bytes: new TextEncoder().encode("not JSON"),
      cwd: CWD,
    });
    const badCsv = inspectText({
      inputPath: "claim.csv",
      bytes: new TextEncoder().encode("a,b\n1"),
      cwd: CWD,
    });

    expect(badJson).toMatchObject({
      outcome: "parse-failed",
      formatClassification: "declared",
      structure: { kind: "parse-failed", reason: expect.stringContaining("JSON parsing failed") },
    });
    expect(badCsv).toMatchObject({
      outcome: "parse-failed",
      structure: { kind: "parse-failed", reason: expect.stringContaining("row 2") },
    });
    if (badJson.outcome !== "parse-failed")
      throw new Error("expected a parse failure with decoded text");
    expect(badJson.sections.map((section) => section.text).join("")).toBe("not JSON");
    expect(badJson.coverage.totalCharacters).toBe(8);
  });

  // A guessed format that fails is this tool being wrong about a file, not the file being broken.
  // Losing the contents over a wrong guess is what made an ordinary log unreadable.
  it("keeps an inferred structure failure separate from a declared one", () => {
    const prose = inspectText({
      inputPath: "notes.log",
      bytes: new TextEncoder().encode(
        "a, b\nc, d\ne, f\nthis line, has, three commas\nmore text\n",
      ),
      cwd: CWD,
    });

    expect(prose).toMatchObject({
      outcome: "parse-failed",
      format: "csv",
      formatClassification: "inferred",
    });
    if (prose.outcome !== "parse-failed")
      throw new Error("expected a parse failure with decoded text");
    expect(prose.sections.map((section) => section.text).join("")).toContain("more text");
  });

  it("parses quoted CSV fields and rejects unterminated quotes", () => {
    expect(parseCsv('name,note\nAda,"one, two"\n')).toEqual([
      ["name", "note"],
      ["Ada", "one, two"],
    ]);
    expect(() => parseCsv('name,note\nAda,"unfinished')).toThrow(/unterminated/);
    expect(() => parseCsv('name,note\nAda,"closed"extra')).toThrow(/after a closing quote/);
  });

  it("sniffs obvious JSON, XML, Markdown, and CSV when no useful extension exists", () => {
    expect(detectTextFormat("data", '{"ok":true}')).toEqual({
      format: "json",
      classification: "inferred",
    });
    expect(detectTextFormat("data", "<report><ok/></report>")).toEqual({
      format: "xml",
      classification: "inferred",
    });
    expect(detectTextFormat("data", "# Heading\ntext")).toEqual({
      format: "markdown",
      classification: "inferred",
    });
    expect(detectTextFormat("data", "a,b\n1,2\n")).toEqual({
      format: "csv",
      classification: "inferred",
    });
    expect(detectTextFormat("data.json", "{}")).toEqual({
      format: "json",
      classification: "declared",
    });
  });
});

describe("bounded coverage", () => {
  it("retains the complete decoded file when it fits the character bound", () => {
    const selected = selectTextSections("one\ntwo\n", 100);

    expect(selected.coverage).toMatchObject({
      totalCharacters: 8,
      totalLines: 2,
      boundedBy: "complete",
    });
    expect(selected.sections).toEqual([
      { startCharacter: 0, endCharacter: 8, startLine: 1, endLine: 2, text: "one\ntwo\n" },
    ]);
  });

  it("retains exact head and tail ranges and exposes the omitted middle", () => {
    const selected = selectTextSections("0123456789", 6);

    expect(selected.coverage).toEqual({
      totalCharacters: 10,
      totalLines: 1,
      maximumCharacters: 6,
      boundedBy: "maximum-characters",
      retainedRanges: [
        { startCharacter: 0, endCharacter: 3 },
        { startCharacter: 7, endCharacter: 10 },
      ],
      omittedRanges: [{ startCharacter: 3, endCharacter: 7 }],
    });
    expect(selected.sections.map((section) => section.text)).toEqual(["012", "789"]);
  });

  it("counts Unicode code points rather than splitting a surrogate pair", () => {
    const selected = selectTextSections("A😀BC", 3);

    expect(selected.coverage.totalCharacters).toBe(4);
    expect(selected.sections.map((section) => section.text)).toEqual(["A😀", "C"]);
  });

  it("reports an empty valid file without inventing a retained line", () => {
    const result = inspectText({ inputPath: "empty.txt", bytes: new Uint8Array(), cwd: CWD });

    expect(result).toMatchObject({
      outcome: "ok",
      coverage: { totalCharacters: 0, totalLines: 0, retainedRanges: [], omittedRanges: [] },
      sections: [],
    });
  });
});
