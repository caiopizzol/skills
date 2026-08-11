# Routing evaluation design

## Build the dataset

Write the routing contract from the workflow body before proposing metadata. A case labels the skill
that should handle the request, or `null` when no evaluated skill should activate. Use the nearest real
competitors; an isolated target cannot reveal confusion.

Cover these request shapes:

- direct goals using expected vocabulary;
- indirect goals and paraphrases;
- incomplete inputs that should still enter the workflow and request missing information;
- adjacent goals owned by competitors;
- explanation-only requests mentioning trigger terms;
- unsupported operations on the same product or artifact;
- another language, shorthand, or typos when users employ them;
- high-risk false positives even when they are uncommon.

Keep development and holdout prompts separate. Author the holdout before reading candidate results when
possible. Ambiguous prompts need an accepted set of routes or exclusion from exact accuracy; forcing one
label produces noisy evidence.

## Experiment JSON

The target is a logical result label. A variant's optional `name` is the frontmatter name Codex sees;
the evaluator normalizes its marker back to `target` for comparison.

```json
{
  "name": "Example routing experiment",
  "target": "configure-widget",
  "variants": [
    {
      "id": "current",
      "description": "Configure widget settings."
    },
    {
      "id": "renamed-bounded",
      "name": "configure-widget-policy",
      "description": "Configure widget policy when the user wants settings inspected or changed. Do not use for explanations."
    }
  ],
  "competitors": [
    {
      "name": "explain-widget",
      "description": "Explain widget concepts without inspecting or changing settings."
    }
  ],
  "cases": [
    {
      "id": "change-policy",
      "prompt": "Turn on the strict widget policy.",
      "expected": "configure-widget"
    },
    {
      "id": "explain-policy",
      "prompt": "Why would I use the strict widget policy?",
      "expected": "explain-widget"
    },
    {
      "id": "unrelated",
      "prompt": "Delete the widget account.",
      "expected": null
    }
  ]
}
```

Run from any checkout with Bun and an authenticated Codex CLI:

```sh
bun --no-env-file <skill-directory>/scripts/evaluate.ts \
  <experiment.json> --model <model> [--repetitions N] \
  [--variant ID] [--case ID] [--timeout-ms N] [--artifacts-dir PATH]
```

The evaluator creates immutable temporary skills whose bodies only return markers. It disables installed
copies of evaluated names, verifies the effective catalog before spending a model call, runs Codex with a
read-only sandbox, and writes JSONL plus `report.json` outside the repository by default.

## Compare variants

Start with description ablations while keeping the name fixed:

1. Current metadata.
2. Core job only.
3. Core job plus user goals and common trigger language.
4. The prior variant plus boundaries against observed false activations.

Only test names after finding a viable description. Cross at least these names with the same description:

- current name;
- short verb-led candidate;
- more explicit candidate when it adds real disambiguation;
- vague control to measure how much the description carries.

Compare exact accuracy, target recall, target false activations, and the full misroute destination. Repeat
failures: routing is stochastic, so one pass is discovery evidence rather than a conclusion.

## Evidence established so far

The first repository experiment found these provisional patterns on GPT-5.6 Sol with Codex CLI 0.147.0:

- easy prompts let a strong existing name and clear competitors mask description differences;
- a broad description over-triggered on unrelated settings regardless of whether the name was concise,
  explicit, or vague;
- an intent-bounded description prevented those false activations across all tested names;
- a longer explicit name did not repair the broad description or outperform the existing concise name;
- a vague name introduced one additional competitor confusion with the broad description, but that single
  event did not repeat consistently.

Treat these as starting hypotheses, not universal rules. Re-run against the target catalog, model, and
runtime instead of copying the winning wording.
