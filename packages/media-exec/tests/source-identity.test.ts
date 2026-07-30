import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectInputChange, readSourceIdentity } from "../src/index.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "source-identity-"));
  directories.push(directory);
  return directory;
}

describe("source identity revalidation", () => {
  it("accepts a run whose original never changed", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "input.bin");
    await writeFile(inputPath, "original");
    const { identity } = await readSourceIdentity(inputPath);
    const derivativePath = join(directory, "derivative.bin");
    await writeFile(derivativePath, "derived");

    expect(await detectInputChange({ identity, writtenPaths: [derivativePath] })).toBeNull();
    expect(existsSync(derivativePath)).toBe(true);
  });

  // A derivative records a parent SHA-256 taken before the tool read the file. If the file changed
  // in between, that record binds the derivative to bytes the tool never saw.
  it("deletes every derivative when the original changed mid-run", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "input.bin");
    await writeFile(inputPath, "original");
    const { identity } = await readSourceIdentity(inputPath);
    const first = join(directory, "first.bin");
    const second = join(directory, "second.bin");
    await writeFile(first, "derived one");
    await writeFile(second, "derived two");
    await writeFile(inputPath, "swapped");

    const changed = await detectInputChange({ identity, writtenPaths: [first, second] });

    expect(changed).toMatchObject({ outcome: "input-changed", initialSha256: identity.sha256 });
    expect(changed?.finalSha256).not.toBe(identity.sha256);
    // Removing the manifest entry is not enough: a file left on disk is one an agent can still open.
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it("treats a vanished original as changed rather than crashing", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "input.bin");
    await writeFile(inputPath, "original");
    const { identity } = await readSourceIdentity(inputPath);
    await rm(inputPath);

    expect(await detectInputChange({ identity, writtenPaths: [] })).toMatchObject({
      outcome: "input-changed",
      finalSha256: "unreadable",
    });
  });

  it("hashes the exact bytes on disk", async () => {
    const directory = await temporaryDirectory();
    const inputPath = join(directory, "input.bin");
    await writeFile(inputPath, "original");
    const { identity, bytes } = await readSourceIdentity(inputPath);

    expect(new Uint8Array(bytes)).toEqual(new Uint8Array(await readFile(inputPath)));
    expect(identity.bytes).toBe(8);
  });
});
