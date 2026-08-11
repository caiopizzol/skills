import { describe, expect, it } from "bun:test";
import {
  classifyCodexOutput,
  marker,
  parseExperiment,
  renderProbeSkill,
  scoreRuns,
  type RoutingRun,
} from "../../skills/development/improve-skill-metadata/scripts/evaluate.ts";

function output(response: string, overrides: { exitCode?: number; timedOut?: boolean } = {}) {
  return {
    exitCode: overrides.exitCode ?? 0,
    timedOut: overrides.timedOut ?? false,
    stdout: `${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: response },
    })}\n`,
    stderr: "",
  };
}

describe("skill routing experiment input", () => {
  it("accepts labeled variants and refuses unknown expected skills", () => {
    const base = {
      name: "Fixture routing",
      target: "target-skill",
      variants: [{ id: "core", description: "Do the target job." }],
      competitors: [{ name: "other-skill", description: "Do the other job." }],
      cases: [{ id: "target", prompt: "Do it", expected: "target-skill" }],
    };

    expect(parseExperiment(base).target).toBe("target-skill");
    expect(
      parseExperiment({
        ...base,
        variants: [
          { id: "renamed", name: "better-target-name", description: "Do the target job." },
        ],
      }).variants[0]?.name,
    ).toBe("better-target-name");
    expect(() =>
      parseExperiment({
        ...base,
        cases: [{ id: "unknown", prompt: "Do it", expected: "missing-skill" }],
      }),
    ).toThrow("must be null or one of");
  });
});

describe("routing probe", () => {
  it("puts only routing metadata in frontmatter and an inert marker in the body", () => {
    const rendered = renderProbeSkill({
      name: "target-skill",
      description: "Do a target task when the user asks for it.",
    });

    expect(rendered).toContain('description: "Do a target task when the user asks for it."');
    expect(rendered).toContain(marker("target-skill"));
    expect(rendered).toContain("Do not perform the user's task or call tools.");
  });

  it("can vary the visible name while reporting the logical target", () => {
    const rendered = renderProbeSkill(
      { name: "candidate-name", description: "Do the target job." },
      "target-skill",
    );

    expect(rendered).toContain("name: candidate-name");
    expect(rendered).toContain(marker("target-skill"));
    expect(rendered).not.toContain(marker("candidate-name"));
  });
});

describe("Codex output classification", () => {
  const skills = new Set(["target-skill", "other-skill"]);

  it("observes one selected marker or no selected skill", () => {
    expect(classifyCodexOutput(output(marker("target-skill")), skills)).toMatchObject({
      status: "ok",
      selected: "target-skill",
    });
    expect(classifyCodexOutput(output("A normal response"), skills)).toMatchObject({
      status: "ok",
      selected: null,
    });
  });

  it("keeps timeouts, runtime failures, and malformed streams distinct", () => {
    expect(classifyCodexOutput(output("", { timedOut: true }), skills).status).toBe("timeout");
    expect(
      classifyCodexOutput(
        {
          exitCode: null,
          timedOut: false,
          stdout: "",
          stderr: "tool-unavailable: codex was not found",
        },
        skills,
      ).status,
    ).toBe("tool-unavailable");
    expect(classifyCodexOutput(output("", { exitCode: 1 }), skills).status).toBe("runtime-error");
    expect(
      classifyCodexOutput(
        { exitCode: 0, timedOut: false, stdout: "not json\n", stderr: "" },
        skills,
      ).status,
    ).toBe("invalid-output");
  });

  it("refuses an ambiguous response containing multiple markers", () => {
    const result = classifyCodexOutput(
      output(`${marker("target-skill")} ${marker("other-skill")}`),
      skills,
    );
    expect(result.status).toBe("invalid-output");
  });
});

describe("routing scores", () => {
  it("reports target recall separately from false activation", () => {
    const ok = (selected: string | null) => ({ status: "ok" as const, selected, response: "" });
    const runs: RoutingRun[] = [
      {
        variant: "core",
        case: "positive",
        repetition: 1,
        expected: "target-skill",
        outcome: ok("target-skill"),
      },
      {
        variant: "core",
        case: "negative",
        repetition: 1,
        expected: "other-skill",
        outcome: ok("target-skill"),
      },
      {
        variant: "bounded",
        case: "positive",
        repetition: 1,
        expected: "target-skill",
        outcome: ok("target-skill"),
      },
      {
        variant: "bounded",
        case: "negative",
        repetition: 1,
        expected: "other-skill",
        outcome: ok("other-skill"),
      },
    ];

    expect(scoreRuns(runs, "target-skill")).toEqual([
      {
        variant: "core",
        correct: 1,
        scorable: 2,
        errors: 0,
        targetHits: 1,
        targetCases: 1,
        targetFalseActivations: 1,
        nonTargetCases: 1,
      },
      {
        variant: "bounded",
        correct: 2,
        scorable: 2,
        errors: 0,
        targetHits: 1,
        targetCases: 1,
        targetFalseActivations: 0,
        nonTargetCases: 1,
      },
    ]);
  });
});
