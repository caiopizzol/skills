import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { validateCatalog } from "@caiopizzol/catalog-validation";
import { parseAgentMetadata, readCatalog, skillDirectories } from "../src/read-catalog.ts";

const CLI = resolve(import.meta.dirname, "..", "src", "cli.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// A repository laid out the way the real one is, so the boundary is exercised against files on disk
// rather than against a hand-built object.
async function repository(agentMetadata: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "catalog-"));
  directories.push(root);
  const skill = join(root, "skills", "files", "read-image");
  await mkdir(join(skill, "agents"), { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: read-image\ndescription: Reads an image.\n---\n\n# Read an image\n",
  );
  await writeFile(join(skill, "agents", "openai.yaml"), agentMetadata);
  await writeFile(
    join(root, "README.md"),
    "# Repository\n\n## Skill catalog\n\n| Skill | Layer |\n| --- | --- |\n| [`read-image`](skills/files/read-image/SKILL.md) | Interpretation |\n",
  );
  return root;
}

const VALID =
  'interface:\n  display_name: "Read image"\n  default_prompt: "Use $read-image on the exact input."\n';

async function runCli(root: string): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn(["bun", CLI, root], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { exitCode, stderr };
}

// These call the function the command calls. A test that reimplemented the parse would prove the
// runtime works while saying nothing about whether this boundary is still connected: replacing the
// parse with raw-text matching once left every test green while a malformed file validated cleanly.
describe("the production parse boundary", () => {
  it.each([
    {
      label: "an unterminated quoted scalar",
      source: 'interface:\n  default_prompt: "Use $read-image\n',
    },
    {
      label: "inconsistent indentation",
      source: 'interface:\n  display_name: "A"\n     default_prompt: "Use $read-image"\n',
    },
    {
      label: "unescaped internal double quotes",
      source: 'interface:\n  default_prompt: "Use "$read-image" now"\n',
    },
    {
      label: "an illegal colon in a plain scalar",
      source: "interface:\n  default_prompt: Use $read-image: now\n",
    },
  ])("rejects $label as unparseable", ({ source }) => {
    expect(parseAgentMetadata(source)).toMatchObject({ error: expect.any(String) });
  });

  // A boundary that rejected everything would satisfy every row above.
  it("accepts well-formed metadata and yields the parsed document", () => {
    const parsed = parseAgentMetadata(VALID);

    expect(parsed).toEqual({
      document: {
        interface: {
          display_name: "Read image",
          default_prompt: "Use $read-image on the exact input.",
        },
      },
    });
  });

  // Valid YAML carrying the wrong type is what a text search cannot see. The parser accepts it and
  // the shape check in the pure package rejects it.
  it("parses a null prompt so the shape check can reject it", () => {
    expect(parseAgentMetadata("interface:\n  default_prompt: null # Use $read-image\n")).toEqual({
      document: { interface: { default_prompt: null } },
    });
  });
});

describe("reading a repository", () => {
  it("validates a well-formed catalog with no violations", async () => {
    expect(validateCatalog(readCatalog(await repository(VALID)))).toEqual([]);
  });

  it("reports malformed metadata found on disk", async () => {
    const root = await repository('interface:\n  default_prompt: "Use $read-image\n');

    expect(validateCatalog(readCatalog(root))).toEqual([
      {
        rule: "agent-metadata-invalid",
        skill: "read-image",
        detail: expect.stringContaining("not valid YAML"),
      },
    ]);
  });

  it("reports valid YAML whose prompt is not a usable string", async () => {
    const root = await repository("interface:\n  default_prompt: null # Use $read-image\n");

    expect(validateCatalog(readCatalog(root))).toEqual([
      {
        rule: "agent-metadata-invalid",
        skill: "read-image",
        detail: expect.stringContaining("interface.default_prompt"),
      },
    ]);
  });
});

describe("the command", () => {
  it("exits 0 on a healthy catalog", async () => {
    expect(await runCli(await repository(VALID))).toMatchObject({ exitCode: 0 });
  });

  it("exits 1 and names the violation on a malformed catalog", async () => {
    const run = await runCli(await repository('interface:\n  default_prompt: "Use $read-image\n'));

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("not valid YAML");
  });
});

describe("finding skills under categories", () => {
  it("finds a skill at any category depth", async () => {
    const root = await repository(VALID);
    const deep = join(root, "skills", "files", "raster", "read-png");
    await mkdir(join(deep, "agents"), { recursive: true });
    await writeFile(
      join(deep, "SKILL.md"),
      "---\nname: read-png\ndescription: Reads a PNG.\n---\n\n# Read a PNG\n",
    );

    const found = skillDirectories(join(root, "skills"));

    expect(found.map((path) => relative(root, path)).sort()).toEqual([
      "skills/files/raster/read-png",
      "skills/files/read-image",
    ]);
  });

  it("records each skill's folder so a catalog row can be checked against it", async () => {
    const root = await repository(VALID);

    expect(readCatalog(root).skills).toMatchObject([
      { name: "read-image", path: "skills/files/read-image" },
    ]);
  });

  // A skill may ship an example that happens to contain a SKILL.md. Descending past a leaf would turn
  // that example into a phantom catalog entry, which then fails rules about a skill nobody wrote.
  it("does not descend past a skill into folders it owns", async () => {
    const root = await repository(VALID);
    const nested = join(root, "skills", "files", "read-image", "examples", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "SKILL.md"),
      "---\nname: nested\ndescription: An example.\n---\n\n# nested\n",
    );

    expect(skillDirectories(join(root, "skills")).map((path) => relative(root, path))).toEqual([
      "skills/files/read-image",
    ]);
  });

  it("finds nothing when there is no skills directory at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-"));
    directories.push(root);

    expect(skillDirectories(join(root, "skills"))).toEqual([]);
  });
});
