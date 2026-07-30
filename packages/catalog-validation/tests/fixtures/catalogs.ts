import type { AgentMetadataSource, CatalogSource, SkillSource } from "../../src/index.ts";

// The validator receives parsed YAML, so fixtures build the document directly. Whether a given
// string is valid YAML is the parser's job, and it is exercised where the parsing happens.
export function metadata(defaultPrompt: unknown, displayName = "A skill"): AgentMetadataSource {
  return { document: { interface: { display_name: displayName, default_prompt: defaultPrompt } } };
}

export function skill(name: string, body = "", overrides: Partial<SkillSource> = {}): SkillSource {
  return {
    name,
    path: `skills/files/${name}`,
    entry: `---\nname: ${name}\ndescription: Reads one exact thing and reports its gaps.\n---\n\n# ${name}\n\n${body}`,
    agentMetadata: metadata(`Use $${name} on the exact input.`, name),
    ...overrides,
  };
}

export function catalog(skills: SkillSource[], readmeOverride?: string): CatalogSource {
  const rows = skills.map((s) => `| [\`${s.name}\`](${s.path}/SKILL.md) | Interpretation | Reads one thing |`).join("\n");
  const readme = `# Repository\n\n## Skill catalog\n\n| Skill | Layer | Responsibility |\n| --- | --- | --- |\n${rows}\n\n## Quick start\n\nRun the tests.\n`;
  return { skills, readme: readmeOverride ?? readme };
}
