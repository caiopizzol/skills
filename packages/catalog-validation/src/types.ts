// The catalog is a contract between the repository and every runtime that installs it. A skill
// that is present but unlisted, a `$child` reference nothing owns, or agent metadata naming the
// wrong skill are all silent failures: nothing breaks until an agent looks for something that is
// not there. These checks run over a plain description of the catalog so they can be tested with
// fixtures rather than only against this repository's own files.

export interface SkillSource {
  name: string;
  /**
   * Repository-relative folder, such as `skills/files/read-image`. A category is a filing decision
   * rather than part of a skill's identity, so this is used for messages and README links while
   * `name` remains the thing a reference resolves against.
   */
  path: string;
  /** Raw `SKILL.md` contents, or null when the file is absent. */
  entry: string | null;
  /**
   * Parsed `agents/openai.yaml`. The file is YAML, so it is parsed at the boundary that reads it
   * and this package receives the result: `null` when the file is absent, `{ error }` when it did
   * not parse, and the decoded document otherwise. Validating YAML validity here would mean
   * carrying a YAML implementation into a pure module that has no reason to own one.
   */
  agentMetadata: AgentMetadataSource | null;
  /**
   * Raw contents of every other Markdown file the skill owns, keyed by path relative to the skill
   * folder. A `$child` reference in a reference file is as much a promise as one in the entry, and
   * one of the two dangling references this check was written for lived in exactly that place.
   */
  references?: Record<string, string>;
}

export interface CatalogSource {
  skills: SkillSource[];
  /** Raw `README.md` contents. */
  readme: string;
}

export type AgentMetadataSource = { error: string } | { document: unknown };

export type CatalogRule =
  | "skill-entry-missing"
  | "frontmatter-invalid"
  | "frontmatter-unsupported-field"
  | "skill-name-mismatch"
  | "skill-name-invalid"
  | "description-missing"
  | "readme-entry-missing"
  | "readme-entry-unknown"
  | "child-skill-unknown"
  | "skill-name-duplicate"
  | "readme-path-mismatch"
  | "agent-metadata-missing"
  | "agent-metadata-invalid"
  | "agent-metadata-mismatch";

export interface CatalogViolation {
  rule: CatalogRule;
  skill: string;
  detail: string;
}
