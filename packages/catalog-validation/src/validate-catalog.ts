import type { CatalogSource, CatalogViolation, SkillSource } from "./types.ts";

// A `$name` is a skill invocation only when it is written as inline code. Prose that happens to
// contain a dollar sign is not a reference, and an earlier ad hoc version of this check reported
// exactly that kind of false positive. Requiring the backticks is what separates the two.
const CHILD_REFERENCE = /`\$([a-z][a-z0-9-]*)`/g;

const SUPPORTED_FRONTMATTER = new Set(["name", "description"]);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAXIMUM_SKILL_NAME_LENGTH = 64;

export function parseFrontmatter(entry: string): Map<string, string> | null {
  const match = entry.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const field = line.match(/^([a-z][a-z0-9_-]*):\s*(.+)$/);
    if (!field) return null;
    fields.set(field[1] ?? "", unquote(field[2] ?? ""));
  }
  return fields;
}

// A quoted YAML scalar carries its quotes through this deliberately small parser, so `"   "` would
// otherwise read as a three-space description that passes a non-empty check.
function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return quoted ? (quoted[2] ?? "") : trimmed;
}

export function childReferences(entry: string): string[] {
  return [...new Set([...entry.matchAll(CHILD_REFERENCE)].map((match) => match[1] ?? ""))].sort();
}

export interface CatalogEntry {
  name: string;
  /** The skill folder the row links to, so a row can be checked against where the skill lives. */
  path: string;
}

/**
 * Rows in the catalog table, each carrying the skill folder it links to.
 *
 * The link's final segment must equal the skill name it labels. A category may sit in between, since
 * categories are how the repository files skills, but a row pointing at a different skill's folder is
 * a broken promise about where to read.
 */
export function readmeCatalogEntries(readme: string): CatalogEntry[] {
  const rows = [
    ...catalogSection(readme).matchAll(
      /\[`([a-z0-9-]+)`\]\((skills\/(?:[a-z0-9-]+\/)*([a-z0-9-]+))\/SKILL\.md\)/g,
    ),
  ]
    .filter((match) => match[1] === match[3])
    .map((match) => ({ name: match[1] ?? "", path: match[2] ?? "" }));
  return [...new Map(rows.map((row) => [row.name, row])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// Membership means a row in the catalog table, not a link anywhere in the file. Counting a passing
// mention elsewhere would let a skill drop out of the catalog while a footnote kept the check green.
export function catalogSection(readme: string): string {
  const heading = /^##+\s+Skill catalog\s*$/m.exec(readme);
  if (!heading) return "";
  const rest = readme.slice(heading.index + heading[0].length);
  const next = /^##+\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

export function validateCatalog(source: CatalogSource): CatalogViolation[] {
  const violations: CatalogViolation[] = [];
  const add = (rule: CatalogViolation["rule"], skill: string, detail: string) =>
    violations.push({ rule, skill, detail });
  const installed = new Set(source.skills.map((skill) => skill.name));

  // A name is a skill's identity: it is what `$name` resolves to and what the installed folder is
  // called. Two folders claiming one name make both ambiguous, and filing them under different
  // categories does not separate them.
  const byName = new Map<string, string[]>();
  for (const skill of source.skills)
    byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill.path]);
  for (const [name, paths] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    if (paths.length > 1)
      add(
        "skill-name-duplicate",
        name,
        `provided by ${paths.sort().join(" and ")}; a skill name must be unique`,
      );
  }

  for (const skill of source.skills) validateSkill(skill, installed, add);

  // Every installed skill is listed, and every listed skill is installed. A one-way check lets the
  // catalog drift in whichever direction it is not looking.
  const listed = new Map(readmeCatalogEntries(source.readme).map((entry) => [entry.name, entry]));
  for (const skill of source.skills) {
    const entry = listed.get(skill.name);
    if (entry === undefined)
      add("readme-entry-missing", skill.name, "the README catalog does not list this skill");
    // A row that links somewhere the skill is not sends a reader to a missing file, and moving a
    // skill between categories is exactly when this drifts.
    else if (entry.path !== skill.path) {
      add(
        "readme-path-mismatch",
        skill.name,
        `the README catalog links to ${entry.path} but the skill is at ${skill.path}`,
      );
    }
  }
  for (const name of [...listed.keys()].sort()) {
    if (!installed.has(name))
      add(
        "readme-entry-unknown",
        name,
        "the README catalog lists a skill this repository does not provide",
      );
  }
  return violations;
}

function validateSkill(
  skill: SkillSource,
  installed: ReadonlySet<string>,
  add: (rule: CatalogViolation["rule"], skill: string, detail: string) => void,
): void {
  if (skill.entry === null) {
    add("skill-entry-missing", skill.name, "the skill folder has no SKILL.md");
    return;
  }
  if (!SKILL_NAME.test(skill.name) || skill.name.length >= MAXIMUM_SKILL_NAME_LENGTH) {
    add(
      "skill-name-invalid",
      skill.name,
      "a skill name must be lowercase kebab-case and shorter than 64 characters",
    );
  }
  const fields = parseFrontmatter(skill.entry);
  if (fields === null) {
    add("frontmatter-invalid", skill.name, "SKILL.md has no readable frontmatter block");
    return;
  }
  if (fields.get("name") !== skill.name) {
    add("skill-name-mismatch", skill.name, `frontmatter name is ${fields.get("name") ?? "absent"}`);
  }
  if ((fields.get("description") ?? "").trim() === "") {
    add("description-missing", skill.name, "frontmatter has no description");
  }
  for (const key of [...fields.keys()].sort()) {
    if (!SUPPORTED_FRONTMATTER.has(key))
      add("frontmatter-unsupported-field", skill.name, `unsupported frontmatter field: ${key}`);
  }

  // Every `$child` names a skill this catalog owns, wherever it is written. A reference to
  // something installed separately reads as a promise the repository cannot keep, so it is a
  // violation rather than a warning.
  const owned: Array<[string, string]> = [
    ["SKILL.md", skill.entry],
    ...Object.entries(skill.references ?? {}),
  ];
  for (const [where, markdown] of owned.sort(([a], [b]) => a.localeCompare(b))) {
    for (const reference of childReferences(markdown)) {
      if (!installed.has(reference)) {
        add(
          "child-skill-unknown",
          skill.name,
          `${where} references $${reference}, which this catalog does not provide`,
        );
      }
    }
  }

  if (skill.agentMetadata === null) {
    add("agent-metadata-missing", skill.name, "the skill has no agents/openai.yaml");
    return;
  }
  if ("error" in skill.agentMetadata) {
    add(
      "agent-metadata-invalid",
      skill.name,
      `agents/openai.yaml is not valid YAML: ${skill.agentMetadata.error}`,
    );
    return;
  }
  const prompt = defaultPrompt(skill.agentMetadata.document);
  if (prompt === null) {
    add(
      "agent-metadata-invalid",
      skill.name,
      "agents/openai.yaml has no interface.default_prompt string",
    );
  } else if (!prompt.includes(`$${skill.name}`)) {
    add("agent-metadata-mismatch", skill.name, `default_prompt does not name $${skill.name}`);
  }
}

// The document parsed, so the remaining question is shape: a runtime needs `interface.default_prompt`
// to be a non-empty string. A null, a list, or a nested mapping is valid YAML that gives it nothing.
export function defaultPrompt(document: unknown): string | null {
  if (typeof document !== "object" || document === null) return null;
  const section = (document as Record<string, unknown>)["interface"];
  if (typeof section !== "object" || section === null) return null;
  const prompt = (section as Record<string, unknown>)["default_prompt"];
  return typeof prompt === "string" && prompt.trim() !== "" ? prompt : null;
}
