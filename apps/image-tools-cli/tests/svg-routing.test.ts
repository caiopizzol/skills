import { gzipSync } from "node:zlib";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ExecBoundary, ExecRequest } from "@caiopizzol/media-exec";
import { isComplete, prepareImage, type PrepareImageResult } from "../src/prepare-image.ts";

// The routing tests the original suite lacked. Its one safety test used a file named `unsafe.svg`
// beginning directly with `<svg`, which is the single input where the gate cannot fail. Every case
// below is one where it could, and each asserts the same three things: the outcome is a refusal,
// no rasterizer ran, and nothing survives on disk.

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "svg-routing-"));
  directories.push(directory);
  return directory;
}

const UNSAFE_BODY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>x</script><rect width="40" height="40"/></svg>';
const SAFE_BODY =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>';

interface SpyExec {
  exec: ExecBoundary;
  commands: () => string[];
  conversions: () => ExecRequest[];
}

// Reports SVG for anything it is asked about, which is what a renderer that sniffs content does
// regardless of the filename. That is precisely the disagreement the invariant has to survive.
function spyExec(identifiedFormat = "SVG"): SpyExec {
  const requests: ExecRequest[] = [];
  return {
    commands: () =>
      requests
        .filter((request) => !request.args.includes("-version"))
        .map((request) => request.command),
    conversions: () =>
      requests.filter(
        (request) => request.command === "magick" && !request.args.includes("-version"),
      ),
    exec: async (request) => {
      requests.push(request);
      if (request.args.includes("-version"))
        return { exitCode: 0, stdout: `${request.command} 7.1\n`, stderr: "" };
      if (request.command === "identify")
        return { exitCode: 0, stdout: `${identifiedFormat} 40 40\n`, stderr: "" };
      const target = request.args.at(-1);
      if (target !== undefined) await writeFile(target.replace(/^png:/, ""), "rasterized bytes");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

async function prepare(
  filename: string,
  contents: string | Uint8Array,
): Promise<{ result: PrepareImageResult; spy: SpyExec; directory: string }> {
  const directory = await temporaryDirectory();
  const inputPath = join(directory, filename);
  await writeFile(inputPath, contents);
  const spy = spyExec();
  const result = await prepareImage(
    { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
    { cwd: directory, hostExec: spy.exec },
  );
  return { result, spy, directory };
}

// Each row was confirmed against the pinned ImageMagick image to be routed to an SVG coder, or is
// a spelling of the same evasion. A new bypass should be one more row, not a new test.
const hostile: ReadonlyArray<{ label: string; filename: string; body: string }> = [
  {
    label: "an SVG whose name claims PNG, behind an XML declaration and a comment",
    filename: "attachment.png",
    body: `<?xml version="1.0"?><!-- c -->${UNSAFE_BODY}`,
  },
  {
    label: "the same document named .txt",
    filename: "attachment.txt",
    body: `<?xml version="1.0"?><!-- c -->${UNSAFE_BODY}`,
  },
  {
    label: "the same document named .dat",
    filename: "attachment.dat",
    body: `<?xml version="1.0"?><!-- c -->${UNSAFE_BODY}`,
  },
  {
    label: "the same document named .xml",
    filename: "attachment.xml",
    body: `<?xml version="1.0"?><!-- c -->${UNSAFE_BODY}`,
  },
  {
    label: "the .msvg coder ImageMagick maps to its own SVG renderer",
    filename: "attachment.msvg",
    body: `<!DOCTYPE svg PUBLIC "" "">${UNSAFE_BODY}`,
  },
  {
    label: "a DOCTYPE prefix before the root element",
    filename: "attachment.svg",
    body: `<!DOCTYPE svg PUBLIC "" "">${UNSAFE_BODY}`,
  },
  {
    label: "a leading comment before the root element",
    filename: "attachment.svg",
    body: `<!-- c -->${UNSAFE_BODY}`,
  },
  {
    label: "a root element padded past any prefix window",
    filename: "attachment.png",
    body: `<?xml version="1.0"?>\n${"\n".repeat(50_000)}${UNSAFE_BODY}`,
  },
  {
    label: "whitespace padding with no declaration at all",
    filename: "attachment.png",
    body: `${" ".repeat(50_000)}${UNSAFE_BODY}`,
  },
];

describe("hostile SVG candidates never reach a rasterizer", () => {
  it.each(hostile)("refuses $label", async ({ filename, body }) => {
    const { result, spy, directory } = await prepare(filename, body);

    expect(result.svgSafety?.outcome).toBe("unsafe-input");
    expect(spy.conversions()).toEqual([]);
    expect(isComplete(result)).toBe(false);
    expect(await readdir(join(directory, "artifacts"))).toEqual([]);
  });
});

describe("compressed candidates are refused rather than assumed safe", () => {
  // A gzipped SVG rasterizes perfectly well, so a textual inspector finding nothing in it is
  // silence, not safety.
  it.each([
    { label: ".svgz", filename: "a.svgz" },
    { label: ".svg.gz", filename: "a.svg.gz" },
    { label: "gzip magic bytes under a .png name", filename: "a.png" },
  ])("refuses $label without invoking a tool", async ({ filename }) => {
    const { result, spy } = await prepare(filename, gzipSync(Buffer.from(UNSAFE_BODY)));

    expect(result.classification.kind).toBe("compressed-input");
    expect(result.svgSafety?.outcome).toBe("unsafe-input");
    expect(spy.commands()).toEqual([]);
  });
});

describe("the post-identification invariant", () => {
  // The backstop, exercised on its own. The classifier is told nothing suspicious is present, the
  // renderer answers SVG anyway, and conversion must still never happen.
  it("refuses an SVG identification that no inspection cleared", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "plain.bin");
    // A raster signature, so the classifier routes it as known-raster and no verdict is produced.
    await writeFile(inputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const spy = spyExec("SVG");

    const result = await prepareImage(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      { cwd: directory, hostExec: spy.exec },
    );

    expect(result.classification.kind).toBe("known-raster");
    expect(result.svgSafety?.verdict.reasons[0]?.code).toBe("unverified-svg");
    expect(spy.conversions()).toEqual([]);
    expect(isComplete(result)).toBe(false);
  });

  it.each(["SVGZ", "MSVG"])("covers the %s coder as well as SVG", async (format) => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "plain.bin");
    await writeFile(inputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const spy = spyExec(format);

    const result = await prepareImage(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      { cwd: directory, hostExec: spy.exec },
    );

    expect(result.svgSafety?.verdict.reasons[0]?.code).toBe("unverified-svg");
    expect(spy.conversions()).toEqual([]);
  });
});

describe("safe input still works", () => {
  // A guard that refuses everything would pass every test above. This is the control that fails if
  // the gate stops distinguishing safe from unsafe.
  it("rasterizes a self-contained SVG once inspection cleared it", async () => {
    const { result, spy } = await prepare("safe.svg", SAFE_BODY);

    expect(result.svgSafety?.outcome).toBe("ok");
    expect(result.derivative?.outcome).toBe("ok");
    expect(spy.conversions()).toHaveLength(1);
    expect(isComplete(result)).toBe(true);
  });

  it("leaves a genuine raster untouched by the SVG lane", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "photo.png");
    await writeFile(inputPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    const spy = spyExec("PNG");

    const result = await prepareImage(
      { command: "prepare", inputPath, artifactsDirectory: join(directory, "artifacts") },
      { cwd: directory, hostExec: spy.exec },
    );

    expect(result.classification.kind).toBe("known-raster");
    expect(result.svgSafety).toBeNull();
    expect(result.derivative).toBeNull();
    expect(isComplete(result)).toBe(true);
  });
});
