// The installer is the primary distribution path, so it is tested as a subprocess against real
// directories on disk. A test that imported its internals would prove the algorithm and say nothing
// about the thing a user runs, and the failures worth guarding here — writing into the source catalog, a
// silently smaller closure, a half-finished install, an overwritten destination — are all filesystem
// outcomes.

import {
  mkdtemp,
  mkdir,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

const INSTALLER = resolve(import.meta.dirname, "..", "install-skills.ts");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "install-skills-"));
  temporary.push(root);
  return root;
}

/** A skill in a catalog, at whatever category depth the caller names. */
async function writeSkill(catalogRoot: string, path: string, body = ""): Promise<void> {
  const directory = join(catalogRoot, "skills", path);
  const name = basename(path);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Reads one thing.\n---\n\n# ${name}\n\n${body}`,
  );
}

// The installer resolves its catalog relative to its own location, so a fixture catalog is a copy of
// the script beside a fixture `skills/` tree. This keeps each case's catalog small and explicit
// instead of asserting against whatever this repository currently ships.
async function catalog(): Promise<string> {
  const root = await scratch();
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "apps", "catalog-validation-cli", "src"), { recursive: true });
  await Bun.write(join(root, "scripts", "install-skills.ts"), Bun.file(INSTALLER));
  await Bun.write(
    join(root, "apps", "catalog-validation-cli", "src", "read-catalog.ts"),
    Bun.file(
      resolve(
        import.meta.dirname,
        "..",
        "..",
        "apps",
        "catalog-validation-cli",
        "src",
        "read-catalog.ts",
      ),
    ),
  );
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  // The copied installer imports `@caiopizzol/catalog-validation` for the reference grammar, so the
  // fixture borrows this repository's resolved modules rather than running its own install.
  await symlink(
    resolve(import.meta.dirname, "..", "..", "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  return root;
}

/** Runs the installer that belongs to `root`, which is how it finds the catalog to install from. */
async function installFrom(root: string, destination: string, ...names: string[]) {
  const child = Bun.spawn(
    ["bun", join(root, "scripts", "install-skills.ts"), destination, ...names],
    {
      cwd: root,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("resolving the closure", () => {
  // A parent may not reconstruct a missing child's procedure, so asking for the parent has to bring
  // the children. Installing one skill where three were required is the failure this guards.
  it("installs a parent's transitive children", async () => {
    const root = await catalog();
    await writeSkill(
      root,
      "files/read-video",
      "Frames go to `$read-image`; audio goes to `$transcribe-audio`.",
    );
    await writeSkill(root, "files/read-image");
    await writeSkill(root, "files/transcribe-audio");
    await writeSkill(root, "files/read-text-file");
    const destination = join(await scratch(), "skills");

    const run = await installFrom(root, destination, "read-video");

    expect(run.exitCode).toBe(0);
    expect((await readdir(destination)).sort()).toEqual([
      "read-image",
      "read-video",
      "transcribe-audio",
    ]);
  });

  it("follows a reference written in a file other than the entry point", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-video");
    await writeFile(
      join(root, "skills", "files", "read-video", "sampling.md"),
      "Each frame goes to `$read-image`.\n",
    );
    await writeSkill(root, "files/read-image");
    const destination = join(await scratch(), "skills");

    await installFrom(root, destination, "read-video");

    expect((await readdir(destination)).sort()).toEqual(["read-image", "read-video"]);
  });

  it("terminates on a reference cycle", async () => {
    const root = await catalog();
    await writeSkill(root, "files/a", "See `$b`.");
    await writeSkill(root, "files/b", "See `$a`.");
    const destination = join(await scratch(), "skills");

    const run = await installFrom(root, destination, "a");

    expect(run.exitCode).toBe(0);
    expect((await readdir(destination)).sort()).toEqual(["a", "b"]);
  });

  it("installs the whole catalog when no skill is named", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    await writeSkill(root, "web/read-webpage");
    const destination = join(await scratch(), "skills");

    await installFrom(root, destination);

    expect((await readdir(destination)).sort()).toEqual(["read-image", "read-webpage"]);
  });
});

describe("category filing", () => {
  // Category is organization, not identity: a skill installs under its own name so `$read-image`
  // resolves the same way regardless of how the repository files it.
  it("installs flat regardless of category depth", async () => {
    const root = await catalog();
    await writeSkill(root, "files/raster/deep/read-image");
    const destination = join(await scratch(), "skills");

    await installFrom(root, destination, "read-image");

    expect(await readdir(destination)).toEqual(["read-image"]);
    expect(await realpath(await readlink(join(destination, "read-image")))).toBe(
      await realpath(join(root, "skills", "files", "raster", "deep", "read-image")),
    );
  });

  it("refuses one name claimed by two folders", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    await writeSkill(root, "web/read-image");
    const destination = join(await scratch(), "skills");

    const run = await installFrom(root, destination, "read-image");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("a skill name must be unique");
  });

  it("does not treat a folder a skill owns as a second skill", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    await writeSkill(root, "files/read-image/examples/nested");
    const destination = join(await scratch(), "skills");

    await installFrom(root, destination);

    expect(await readdir(destination)).toEqual(["read-image"]);
  });
});

describe("refusals", () => {
  it("refuses an unknown skill", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    const destination = join(await scratch(), "skills");

    const run = await installFrom(root, destination, "read-pdf");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("unknown skill: read-pdf");
  });

  it("refuses a reference no skill provides, naming where it was written", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-video", "Documents go to `$read-pdf`.");
    const destination = join(await scratch(), "skills");

    const run = await installFrom(root, destination, "read-video");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("$read-pdf");
    expect(run.stderr).toContain("SKILL.md");
  });

  it("refuses to replace an existing installation", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    const destination = join(await scratch(), "skills");
    await installFrom(root, destination, "read-image");

    const run = await installFrom(root, destination, "read-image");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("destination already exists");
  });

  // The closure is larger than what the caller named, so a collision partway through would otherwise
  // leave symlinks they never asked for and no clean way back.
  it("creates nothing when one skill in the closure is already installed", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-video", "Frames go to `$read-image`.");
    await writeSkill(root, "files/read-image");
    const destination = join(await scratch(), "skills");
    await mkdir(destination, { recursive: true });
    await mkdir(join(destination, "read-image"));

    const run = await installFrom(root, destination, "read-video");

    expect(run.exitCode).toBe(1);
    expect(await readdir(destination)).toEqual(["read-image"]);
  });

  it.each(["the filesystem root", "the catalog root"])(
    "refuses %s as a destination",
    async (which) => {
      const root = await catalog();
      await writeSkill(root, "files/read-image");

      const destination = which === "the filesystem root" ? "/" : root;
      const run = await installFrom(root, destination, "read-image");

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("refusing unsafe skills destination");
    },
  );

  it("refuses the catalog's own skills directory as a destination", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");

    const run = await installFrom(root, join(root, "skills"), "read-image");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("refusing unsafe skills destination");
  });

  // `resolve` only normalizes text, so before this the guard could be walked around with a symlink and
  // the installer would write skill folders in among the skills themselves.
  it("refuses the catalog's skills directory reached through a symlink", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    const link = join(await scratch(), "link");
    await symlink(root, link, "dir");

    const run = await installFrom(root, join(link, "skills"), "read-image");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("refusing unsafe skills destination");
    expect((await readdir(join(root, "skills"))).sort()).toEqual(["files"]);
  });

  // Containment, not equality. Installing into `skills/anywhere` scatters skill folders through the
  // catalog exactly as installing into `skills` does, and a nonexistent path cannot be canonicalized
  // directly — so the guard resolves through the nearest existing ancestor. Each case below installed
  // successfully before that change.
  it.each([
    {
      label: "a direct descendant of the catalog",
      destination: (root: string) => join(root, "skills", "inside"),
    },
    {
      label: "a deep descendant of the catalog",
      destination: (root: string) => join(root, "skills", "a", "b", "c"),
    },
  ])("refuses $label", async ({ destination }) => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");

    const run = await installFrom(root, destination(root), "read-image");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("refusing unsafe skills destination");
    expect((await readdir(join(root, "skills"))).sort()).toEqual(["files"]);
  });

  // The one case where a prefix test and a segment test disagree in the unsafe direction: `relative`
  // returns `..installed` for a child of `skills/` named that, which a prefix test reads as having left
  // the directory. It has not. Only an exact `..` segment means that.
  it("refuses a two-dot name inside the source catalog", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");

    const run = await installFrom(root, join(root, "skills", "..installed"), "read-image");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("refusing unsafe skills destination");
    expect((await readdir(join(root, "skills"))).sort()).toEqual(["files"]);
  });

  // The guard protects the source catalog, not the whole working tree. A project-scoped destination is a
  // legitimate thing to want, and none of these writes anywhere near `skills/`.
  it.each([".agents/skills", ".claude/skills", "..installed"])(
    "accepts the repository-local %s",
    async (relativeDestination) => {
      const root = await catalog();
      await writeSkill(root, "files/read-image");

      const run = await installFrom(root, join(root, relativeDestination), "read-image");

      expect(run.exitCode).toBe(0);
      expect(await readdir(join(root, relativeDestination))).toEqual(["read-image"]);
      expect((await readdir(join(root, "skills"))).sort()).toEqual(["files"]);
    },
  );

  it("accepts a two-dot name outside the catalog", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    const destination = join(await scratch(), "..keep", "skills");

    const run = await installFrom(root, destination, "read-image");

    expect(run.exitCode).toBe(0);
    expect(await readdir(destination)).toEqual(["read-image"]);
  });

  it("refuses a nonexistent descendant reached through a symlink to the catalog", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    const alias = join(await scratch(), "alias");
    await symlink(join(root, "skills"), alias, "dir");

    const run = await installFrom(root, join(alias, "new-destination"), "read-image");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("refusing unsafe skills destination");
    expect((await readdir(join(root, "skills"))).sort()).toEqual(["files"]);
  });

  // The counterpart, so the guard cannot pass by refusing everything: a destination that merely does not
  // exist yet is the ordinary case and must still work.
  it("accepts a nonexistent destination outside the catalog", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    const destination = join(await scratch(), "deep", "nested", "skills");

    const run = await installFrom(root, destination, "read-image");

    expect(run.exitCode).toBe(0);
    expect(await readdir(destination)).toEqual(["read-image"]);
  });

  it("reports usage and exits 2 with no destination", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");

    const child = Bun.spawn(["bun", join(root, "scripts", "install-skills.ts")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Usage:");
  });

  it("reports an empty catalog rather than creating an empty destination", async () => {
    const root = await catalog();
    await mkdir(join(root, "skills"), { recursive: true });
    const destination = join(await scratch(), "skills");

    const run = await installFrom(root, destination);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("no skills found");
  });
});

describe("agreeing with the validator about what a skill owns", () => {
  // Two different answers to "which files does this skill own" is worse than either answer alone: an
  // ignored file carrying a dangling reference passed a green `validate:skills` and then broke
  // installation. Validation passing while users cannot install is the shape to avoid.
  it.each(["artifacts", "tmp", "node_modules"])(
    "ignores a reference inside %s, as validation does",
    async (ignored) => {
      const root = await catalog();
      await writeSkill(root, "files/read-image");
      await mkdir(join(root, "skills", "files", "read-image", ignored), { recursive: true });
      await writeFile(
        join(root, "skills", "files", "read-image", ignored, "note.md"),
        "Mentions `$read-pdf`.\n",
      );
      const destination = join(await scratch(), "skills");

      const run = await installFrom(root, destination, "read-image");

      expect(run.exitCode).toBe(0);
      expect(await readdir(destination)).toEqual(["read-image"]);
    },
  );

  // The counterpart: a reference in a file the skill really does own still binds.
  it("still resolves a reference in a file the skill owns", async () => {
    const root = await catalog();
    await writeSkill(root, "files/read-image");
    await writeFile(
      join(root, "skills", "files", "read-image", "formats.md"),
      "Mentions `$read-pdf`.\n",
    );
    const destination = join(await scratch(), "skills");

    const run = await installFrom(root, destination, "read-image");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("$read-pdf");
  });
});

describe("this repository's own catalog", () => {
  // The fixture cases above prove the algorithm; this proves the shipped catalog is installable, which
  // is the claim the README makes.
  it("installs read-video and its two children", async () => {
    const destination = join(await scratch(), "skills");

    const run = await installFrom(
      resolve(import.meta.dirname, "..", ".."),
      destination,
      "read-video",
    );

    expect(run.exitCode).toBe(0);
    expect((await readdir(destination)).sort()).toEqual([
      "read-image",
      "read-video",
      "transcribe-audio",
    ]);
  });
});
