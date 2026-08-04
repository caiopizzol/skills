// Installs skills into a runtime's skill directory as symlinks, resolving each request's transitive
// child references first.
//
// A `$child` reference is a required installation dependency, not a suggestion: a parent skill is
// forbidden from reconstructing a missing child's procedure, so a parent installed without its
// children is a broken installation rather than a smaller one. Runtime credentials and external tools
// are different — those are capabilities that may be absent after a correct install, and the skills
// report them as explicit gaps.
//
// Installation is flat even though the repository files skills under categories. A skill's identity is
// its frontmatter name, `$read-image` has to resolve the same way regardless of where it is filed, and
// runtimes are not assumed to discover nested folders.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { childReferences } from "@caiopizzol/catalog-validation";
import {
  markdownFiles,
  skillDirectories,
} from "../apps/catalog-validation-cli/src/read-catalog.ts";

const [destinationArgument, ...requested] = process.argv.slice(2);
if (!destinationArgument) {
  console.error("Usage: bun run install:skills -- <runtime-skills-directory> [skill-name ...]");
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const skillsRoot = join(root, "skills");
const destination = resolve(destinationArgument);
if (isForbiddenDestination(destination)) {
  fail(`refusing unsafe skills destination: ${destination}`);
}

/**
 * Whether a destination is somewhere skills must not be installed.
 *
 * Three separate questions, deliberately not one rule:
 *
 * - The filesystem root and the repository root are refused by **equality**. Every absolute path is
 *   beneath the filesystem root, and a repository-local destination such as `.agents/skills` is a
 *   legitimate place to install for project-scoped agent configuration — it writes nowhere near the
 *   source catalog. Treating either as containment refuses destinations that are fine.
 * - The source `skills/` directory is refused by **containment**, because `skills/anywhere` scatters
 *   installed folders in among the skills themselves just as `skills` does, and a level deeper is no
 *   more deliberate.
 *
 * Containment is decided from `relative`'s path segments, not its prefix. `..installed` is a legitimate
 * child whose name begins with two dots, and a `startsWith("..")` test reads it as escaping. Only an
 * exact `..` segment means the path left the directory. `media-exec`'s `resolveWriteTarget` asks the
 * inverse question, where that same imprecision is over-strict and fails closed; here it would fail open.
 *
 * Paths are canonicalized through their nearest existing ancestor, because `resolve` only normalizes
 * text while `realpathSync` needs the path to exist — and a destination that does not exist yet is the
 * ordinary case. Walking up to the first existing ancestor resolves every symlink on the way, so an
 * alias pointing at the catalog cannot smuggle a nonexistent child past.
 */
function isForbiddenDestination(path: string): boolean {
  const target = canonical(path);
  if ([resolve("/"), root].map(canonical).includes(target)) return true;
  const containment = relative(canonical(skillsRoot), target);
  if (containment === "") return true;
  if (isAbsolute(containment)) return false;
  return !containment.split(sep).includes("..");
}

function canonical(path: string): string {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    // `dirname` is its own fixed point at the filesystem root, so this is the stop condition rather
    // than a guard against a path that could loop forever.
    if (parent === existing) return path;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...missing);
}

const available = index();
const selected = closure(requested.length === 0 ? [...available.keys()] : [...new Set(requested)]);

// Every target is checked before anything is created. The closure is larger than what the caller
// named, so a conflicting target must not leave a partly updated installation behind.
const missing: Array<{ directory: string; name: string; target: string }> = [];
for (const name of selected) {
  const directory = owns(name);
  const target = join(destination, name);
  if (!pathExists(target)) missing.push({ directory, name, target });
  else if (!isCurrentInstallation(target, directory)) fail(`destination already exists: ${target}`);
}

mkdirSync(destination, { recursive: true });
for (const installation of missing) {
  symlinkSync(installation.directory, installation.target, "dir");
  console.log(`${installation.name} -> ${relative(root, installation.directory)}`);
}

/** Every skill the catalog provides, keyed by name, refusing a name two folders both claim. */
function index(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const directory of skillDirectories(skillsRoot)) {
    const name = basename(directory);
    const existing = owners.get(name);
    // Two folders make `$name` ambiguous for this installer and for the runtime that resolves it.
    // Filing them under different categories does not make them different skills.
    if (existing) {
      fail(
        `${name} is provided by both ${relative(root, existing)} and ${relative(root, directory)}; a skill name must be unique`,
      );
    }
    owners.set(name, directory);
  }
  if (owners.size === 0) fail(`no skills found beneath ${relative(root, skillsRoot)}`);
  return owners;
}

/** The requested skills plus every skill they reference, transitively. */
function closure(seeds: string[]): string[] {
  const resolved = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || resolved.has(name)) continue;
    if (!available.has(name)) fail(`unknown skill: ${name}`);
    resolved.add(name);
    for (const [where, markdown] of ownedMarkdown(name)) {
      for (const reference of childReferences(markdown)) {
        if (!available.has(reference))
          fail(`${where} references $${reference}, which this catalog does not provide`);
        queue.push(reference);
      }
    }
  }
  return [...resolved].sort();
}

/**
 * A skill's entry point and every other Markdown file it owns, since a reference in either binds.
 *
 * This borrows the validator's walk deliberately. When the two disagreed about what a skill owns, an
 * ignored file could carry a dangling reference past a green `validate:skills` and break installation
 * — validation passing while users cannot install is the worst shape for that disagreement to take.
 */
function ownedMarkdown(name: string): Array<[string, string]> {
  const directory = owns(name);
  if (!existsSync(join(directory, "SKILL.md"))) {
    fail(`${name} has no SKILL.md, so its child references cannot be resolved`);
  }
  return markdownFiles(directory).map((path) => [relative(root, path), readFileSync(path, "utf8")]);
}

function owns(name: string): string {
  const directory = available.get(name);
  if (!directory) fail(`unknown skill: ${name}`);
  return directory;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isCurrentInstallation(target: string, directory: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink() && realpathSync(target) === realpathSync(directory);
  } catch {
    return false;
  }
}

function fail(message: string): never {
  console.error(`Skill installation failed: ${message}`);
  process.exit(1);
}
