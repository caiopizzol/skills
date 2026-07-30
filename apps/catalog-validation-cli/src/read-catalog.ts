// The boundary between the repository on disk and the pure validator. Reading files and parsing
// YAML happen here; deciding what is valid happens in @caiopizzol/catalog-validation.
//
// The YAML parse lives in one exported function so the tests call the same code the command calls.
// A test that reimplements the parse proves the runtime works and says nothing about whether this
// boundary is still connected: replacing this body with raw-text matching once left every test
// green while a malformed file validated cleanly.
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, join, relative } from "node:path";
import type { AgentMetadataSource, CatalogSource } from "@caiopizzol/catalog-validation";

// `artifacts` is where a skill writes derivatives and `tmp` is scratch, so neither holds catalog
// content. Skipping them keeps a run's output from being read back as part of the repository.
const IGNORED_DIRECTORIES = [".git", ".claude", "node_modules", "artifacts", "tmp"];

export function parseAgentMetadata(source: string): AgentMetadataSource {
  try {
    return { document: Bun.YAML.parse(source) };
  } catch (error) {
    return {
      error:
        error instanceof Error ? (error.message.split("\n", 1)[0] ?? "unreadable") : String(error),
    };
  }
}

/**
 * Skill folders, found by looking for `SKILL.md` rather than by listing one level.
 *
 * Categories group skills for a human reading the repository, so the depth a skill sits at is a
 * filing decision and not part of its identity: a skill is named by its frontmatter, installs flat,
 * and is invoked as `$name` wherever the folder lives. Discovery therefore stops at the first
 * directory holding an entry point instead of assuming a fixed depth.
 */
export function skillDirectories(skillsRoot: string): string[] {
  const found: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.includes(entry.name)) continue;
    const directory = join(skillsRoot, entry.name);
    // A leaf is not descended into, so a skill that ships an example nested skill folder cannot
    // accidentally contribute a second catalog entry.
    if (existsSync(join(directory, "SKILL.md"))) found.push(directory);
    else found.push(...skillDirectories(directory));
  }
  return found;
}

export function readCatalog(root: string): CatalogSource {
  const skillsRoot = join(root, "skills");
  const skills = skillDirectories(skillsRoot).map((directory) => {
    const metadata = read(join(directory, "agents", "openai.yaml"));
    return {
      name: basename(directory),
      path: relative(root, directory),
      entry: read(join(directory, "SKILL.md")),
      agentMetadata: metadata === null ? null : parseAgentMetadata(metadata),
      references: ownedMarkdown(directory),
    };
  });
  return { skills, readme: readFileSync(join(root, "README.md"), "utf8") };
}

// Every Markdown file a skill owns except its entry point, so a `$child` promise written in a
// reference is checked the same way as one written in SKILL.md.
function ownedMarkdown(skillDirectory: string): Record<string, string> {
  const owned: Record<string, string> = {};
  for (const path of markdownFiles(skillDirectory)) {
    const key = relative(skillDirectory, path);
    if (key !== "SKILL.md") owned[key] = readFileSync(path, "utf8");
  }
  return owned;
}

export function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED_DIRECTORIES.includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
