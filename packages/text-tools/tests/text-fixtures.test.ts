import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectText, type TextFormat } from "../src/index.ts";

interface TextFixtureManifest {
  schemaVersion: number;
  fixtures: Array<{ filename: string; mediaType: string; token: string; bytes: number; sha256: string }>;
}

const fixtureDirectory = join(import.meta.dirname, "fixtures", "files");
const manifest = JSON.parse(readFileSync(join(fixtureDirectory, "manifest.json"), "utf8")) as TextFixtureManifest;
const expectedMatrix: ReadonlyArray<[string, string, TextFormat]> = [
  ["fixture-text.txt", "text/plain", "plain"],
  ["fixture-markdown.md", "text/markdown", "markdown"],
  ["fixture-json.json", "application/json", "json"],
  ["fixture-xml.xml", "application/xml", "xml"],
  ["fixture-csv.csv", "text/csv", "csv"],
];

describe("text fixture ownership", () => {
  it("keeps the supported matrix explicit", () => {
    expect(manifest.fixtures.map(({ filename, mediaType }) => [filename, mediaType])).toEqual(
      expectedMatrix.map(([filename, mediaType]) => [filename, mediaType]),
    );
  });

  it.each(manifest.fixtures)("identifies, hashes, and fully retains $filename", (fixture) => {
    const bytes = readFileSync(join(fixtureDirectory, fixture.filename));
    const expectedFormat = expectedMatrix.find(([filename]) => filename === fixture.filename)?.[2];
    const result = inspectText({ inputPath: fixture.filename, bytes, cwd: fixtureDirectory });

    expect(bytes.byteLength).toBe(fixture.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
    expect(result).toMatchObject({ outcome: "ok", sha256: fixture.sha256, encoding: "utf-8", format: expectedFormat });
    if (result.outcome !== "ok") throw new Error(`expected ok, received ${result.outcome}`);
    expect(result.coverage.boundedBy).toBe("complete");
    expect(result.coverage.omittedRanges).toEqual([]);
    expect(result.sections.map((section) => section.text).join("\n")).toContain(fixture.token);
  });

  it("parses JSON and CSV structure while keeping XML validation explicit", () => {
    const json = inspectFixture("fixture-json.json");
    const csv = inspectFixture("fixture-csv.csv");
    const xml = inspectFixture("fixture-xml.xml");

    expect(json.structure).toEqual({
      kind: "json",
      rootType: "object",
      topLevelKeys: ["environment", "events", "retryable", "token"],
    });
    expect(csv.structure).toEqual({
      kind: "csv",
      headers: ["token", "step", "status", "duration_ms"],
      rowCount: 3,
      columnCount: 4,
    });
    expect(xml.structure).toMatchObject({ kind: "unvalidated", reason: expect.stringContaining("no XML parser") });
  });
});

function inspectFixture(filename: string) {
  const result = inspectText({ inputPath: filename, bytes: readFileSync(join(fixtureDirectory, filename)), cwd: fixtureDirectory });
  if (result.outcome !== "ok") throw new Error(`expected ${filename} to inspect successfully`);
  return result;
}
