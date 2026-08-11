# Evaluate skill routing

## Write test cases

For each request, set `expected` to the skill that should handle it. Use `null` when none of the tested
skills should activate. Include the most similar skills so the test can find routing mistakes.

Include these requests when they matter:

- Direct requests
- Paraphrases and indirect requests
- Incomplete requests that should still start the workflow
- Requests owned by a similar skill
- Explanation-only requests that use similar words
- Unsupported work on the same product or file
- Common translations, shorthand, and typos
- Likely false activations not covered above

Use two sets. Use the working set to improve the metadata. Keep the unseen set for the final check. Write
both before reading any results when possible. Remove ambiguous cases instead of forcing one expected route.

## Create the experiment

`target` is the result label for the skill being tested. A variant can use another `name`. The evaluator
still reports it as `target`, so name variants can be compared.

```json
{
  "name": "Widget routing",
  "target": "configure-widget",
  "variants": [
    {
      "id": "current",
      "description": "Configure widget settings."
    },
    {
      "id": "bounded",
      "description": "Configure widget settings when the user wants them checked or changed. Do not use for explanations."
    }
  ],
  "competitors": [
    {
      "name": "explain-widget",
      "description": "Explain widget settings without checking or changing them."
    }
  ],
  "cases": [
    {
      "id": "change-setting",
      "prompt": "Turn on strict mode.",
      "expected": "configure-widget"
    },
    {
      "id": "explain-setting",
      "prompt": "Why would I use strict mode?",
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

## Run the evaluator

```sh
bun --no-env-file <skill-directory>/scripts/evaluate.ts \
  <experiment.json> --model <model> [--repetitions N] \
  [--variant ID] [--case ID] [--timeout-ms N] [--artifacts-dir PATH]
```

The evaluator replaces each skill body with a fixed label. It checks the catalog, runs Codex in a read-only
sandbox, and writes JSONL and `report.json` outside the repository.

## Compare variants

Test descriptions with the current name first:

1. Current description.
2. Core job only.
3. Core job plus the requests it should handle.
4. The prior version plus wording that prevents false activations seen in earlier results.

Test names only after one description works. Keep that description fixed. Compare the current name, useful
candidates, and one intentionally vague name. The vague name shows how much the description affects routing.

Compare correct routes, missed target routes, false target routes, and where wrong requests went. Repeat
failures before drawing a conclusion, then run the winner against the unseen cases.
