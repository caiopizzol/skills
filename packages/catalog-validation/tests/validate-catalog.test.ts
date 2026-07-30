import { describe, expect, it } from "vite-plus/test";
import {
  childReferences,
  readmeCatalogEntries,
  validateCatalog,
  type CatalogRule,
} from "../src/index.ts";
import { catalog, metadata, skill } from "./fixtures/catalogs.ts";

const rules = (source: Parameters<typeof validateCatalog>[0]): CatalogRule[] =>
  validateCatalog(source)
    .map((violation) => violation.rule)
    .sort();

describe("a healthy catalog", () => {
  it("reports nothing when every skill is listed, owned, and described", () => {
    expect(
      validateCatalog(
        catalog([skill("read-image"), skill("read-video", "Invoke `$read-image` per frame.")]),
      ),
    ).toEqual([]);
  });
});

// Each case below is a defect this repository actually shipped or could ship silently. A rule with
// no failing fixture is a rule nothing proves is wired up.
describe("catalog violations", () => {
  it("catches a skill the README does not list", () => {
    const source = catalog([skill("read-image"), skill("read-video")]);
    source.readme = source.readme.replace(/^.*read-video.*$\n/m, "");

    expect(rules(source)).toEqual(["readme-entry-missing"]);
  });

  it("catches a README entry no skill provides", () => {
    const source = catalog([skill("read-image")]);
    source.readme = source.readme.replace(
      "\n\n## Quick start",
      "\n| [`read-pdf`](skills/read-pdf/SKILL.md) | Interpretation | Reads a PDF |\n\n## Quick start",
    );

    expect(rules(source)).toEqual(["readme-entry-unknown"]);
  });

  it("catches a child reference this catalog does not own", () => {
    expect(rules(catalog([skill("task-context", "PDF: use `$pdf`.")]))).toEqual([
      "child-skill-unknown",
    ]);
  });

  // One of the two dangling references this check was written for lived in a reference file, not in
  // the entry point. Reading only SKILL.md would have missed it.
  it("catches a child reference written in a reference file", () => {
    const source = catalog([
      skill("code-review", "", {
        references: { "references/validation-lanes.md": "Files and media: `$documents` for DOCX." },
      }),
    ]);

    expect(validateCatalog(source)).toEqual([
      {
        rule: "child-skill-unknown",
        skill: "code-review",
        detail:
          "references/validation-lanes.md references $documents, which this catalog does not provide",
      },
    ]);
  });

  it("accepts a reference file that names an installed sibling", () => {
    const source = catalog([
      skill("read-image"),
      skill("read-video", "", {
        references: { "references/sampling.md": "Each frame goes to `$read-image`." },
      }),
    ]);

    expect(validateCatalog(source)).toEqual([]);
  });

  // The file parsed, so what is left is shape: a runtime needs a non-empty string to prompt with.
  // A null, a list, or a nested mapping is valid YAML that gives it nothing.
  it.each([
    { label: "a null prompt", agentMetadata: metadata(null) },
    { label: "a list where a string belongs", agentMetadata: metadata(["Use $read-image"]) },
    {
      label: "a mapping where a string belongs",
      agentMetadata: metadata({ text: "Use $read-image" }),
    },
    { label: "an empty prompt", agentMetadata: metadata("   ") },
    {
      label: "no interface section",
      agentMetadata: { document: { default_prompt: "Use $read-image" } },
    },
    { label: "a scalar document", agentMetadata: { document: "Use $read-image" } },
  ])("catches agent metadata with $label", ({ agentMetadata }) => {
    expect(rules(catalog([skill("read-image", "", { agentMetadata })]))).toEqual([
      "agent-metadata-invalid",
    ]);
  });

  // Whether the bytes were YAML at all is decided by the parser at the reading boundary, which
  // hands the failure through rather than making this package own a YAML implementation.
  it("reports a parse failure from the boundary that read the file", () => {
    const agentMetadata = { error: "unexpected end of the stream within a double quoted scalar" };
    expect(rules(catalog([skill("read-image", "", { agentMetadata })]))).toEqual([
      "agent-metadata-invalid",
    ]);
  });

  it("catches agent metadata with no default prompt at all", () => {
    const agentMetadata = { document: { interface: { display_name: "Read image" } } };
    expect(rules(catalog([skill("read-image", "", { agentMetadata })]))).toEqual([
      "agent-metadata-invalid",
    ]);
  });

  // The token has to be in the prompt a runtime uses, not merely somewhere in the document.
  it("catches a token that appears outside the default prompt", () => {
    const agentMetadata = metadata("Read the file.", "$read-image");
    expect(rules(catalog([skill("read-image", "", { agentMetadata })]))).toEqual([
      "agent-metadata-mismatch",
    ]);
  });

  it("catches missing agent metadata", () => {
    expect(rules(catalog([skill("read-image", "", { agentMetadata: null })]))).toEqual([
      "agent-metadata-missing",
    ]);
  });

  it("catches agent metadata naming a different skill", () => {
    expect(
      rules(
        catalog([
          skill("read-image", "", { agentMetadata: metadata("Use $read-video on the input.") }),
        ]),
      ),
    ).toEqual(["agent-metadata-mismatch"]);
  });

  it("catches a missing SKILL.md without reporting every later rule for it", () => {
    expect(rules(catalog([skill("read-image", "", { entry: null })]))).toEqual([
      "skill-entry-missing",
    ]);
  });

  it("catches unreadable frontmatter", () => {
    expect(rules(catalog([skill("read-image", "", { entry: "# no frontmatter here\n" })]))).toEqual(
      ["frontmatter-invalid"],
    );
  });

  it("catches a frontmatter name that disagrees with the folder", () => {
    const entry = "---\nname: something-else\ndescription: Reads a thing.\n---\n\n# x\n";
    expect(rules(catalog([skill("read-image", "", { entry })]))).toEqual(["skill-name-mismatch"]);
  });

  it("catches an unsupported frontmatter field", () => {
    const entry = "---\nname: read-image\ndescription: Reads a thing.\nversion: 2\n---\n\n# x\n";
    expect(rules(catalog([skill("read-image", "", { entry })]))).toEqual([
      "frontmatter-unsupported-field",
    ]);
  });

  it("catches a description that is present but empty", () => {
    // The frontmatter parser requires a value, so an absent description reads as unreadable
    // frontmatter. This covers the case where a value exists but says nothing.
    const entry = '---\nname: read-image\ndescription: "   "\n---\n\n# x\n';
    expect(rules(catalog([skill("read-image", "", { entry })]))).toContain("description-missing");
  });
});

// The earlier ad hoc version of this check reported prose as a broken reference. Requiring inline
// code is what keeps ordinary writing from failing the build.
describe("child reference detection", () => {
  it("reads only inline-code invocations", () => {
    expect(childReferences("Invoke `$read-image` and `$transcribe-audio`.")).toEqual([
      "read-image",
      "transcribe-audio",
    ]);
  });

  it("ignores a bare dollar token in prose", () => {
    expect(childReferences("A $5 fee, shell $PATH, and a price of $read.")).toEqual([]);
  });

  it("deduplicates repeated references", () => {
    expect(childReferences("`$read-image` then `$read-image` again")).toEqual(["read-image"]);
  });

  it("does not treat a fenced example as a different kind of reference", () => {
    expect(childReferences("Use `$read-video`.\n\n```\n$read-video\n```\n")).toEqual([
      "read-video",
    ]);
  });
});

describe("README catalog parsing", () => {
  it("reads catalog rows with the folder each links to, ignoring unrelated repository links", () => {
    const readme =
      "## Skill catalog\n\n[`read-image`](skills/files/read-image/SKILL.md) and [development](docs/development.md).";
    expect(readmeCatalogEntries(readme)).toEqual([
      { name: "read-image", path: "skills/files/read-image" },
    ]);
  });

  // A category between `skills/` and the skill is a filing decision, so any depth is legitimate as
  // long as the folder the row points at is the skill it labels.
  it("accepts a row at any category depth", () => {
    expect(
      readmeCatalogEntries("## Skill catalog\n\n[`read-image`](skills/read-image/SKILL.md)"),
    ).toEqual([{ name: "read-image", path: "skills/read-image" }]);
    expect(
      readmeCatalogEntries(
        "## Skill catalog\n\n[`read-image`](skills/files/raster/read-image/SKILL.md)",
      ),
    ).toEqual([{ name: "read-image", path: "skills/files/raster/read-image" }]);
  });

  it("ignores a link whose label and folder disagree", () => {
    expect(
      readmeCatalogEntries("## Skill catalog\n\n[`read-image`](skills/files/read-video/SKILL.md)"),
    ).toEqual([]);
  });

  // Membership means a catalog row. A passing mention elsewhere would let a skill drop out of the
  // catalog while a footnote kept the check green.
  it("ignores a skill link outside the catalog section", () => {
    const readme =
      "## Skill catalog\n\n| Skill |\n| --- |\n\n## Notes\n\nSee [`read-image`](skills/files/read-image/SKILL.md).";
    expect(readmeCatalogEntries(readme)).toEqual([]);
  });

  it("reports nothing when the README has no catalog section at all", () => {
    expect(readmeCatalogEntries("# Repository\n\nNo catalog here.")).toEqual([]);
  });
});

// Categories organize the repository; they are not part of a skill's identity. These rules are what
// keep that true, because a name is what `$reference` resolves to and what the installed folder is
// called, and a catalog row is a promise about where to read.
describe("categories and identity", () => {
  it("accepts a skill filed under any category", () => {
    const source = catalog([skill("read-image", "", { path: "skills/files/raster/read-image" })]);

    expect(validateCatalog(source)).toEqual([]);
  });

  it("catches one name claimed by two folders", () => {
    const source = catalog([
      skill("read-image", "", { path: "skills/files/read-image" }),
      skill("read-image", "", { path: "skills/web/read-image" }),
    ]);

    expect(validateCatalog(source)).toContainEqual({
      rule: "skill-name-duplicate",
      skill: "read-image",
      detail:
        "provided by skills/files/read-image and skills/web/read-image; a skill name must be unique",
    });
  });

  // Moving a skill between categories is exactly when a row drifts, and a row pointing at a folder
  // the skill has left sends a reader to a file that is not there.
  it("catches a catalog row linking where the skill is not", () => {
    const source = catalog([skill("read-image")]);
    source.readme = source.readme.replace("skills/files/read-image", "skills/media/read-image");

    expect(validateCatalog(source)).toEqual([
      {
        rule: "readme-path-mismatch",
        skill: "read-image",
        detail:
          "the README catalog links to skills/media/read-image but the skill is at skills/files/read-image",
      },
    ]);
  });
});
