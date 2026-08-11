# Evaluate skill routing

## Write test cases

Label each request with the skill that should handle it, or `null` when none of the evaluated skills should
activate. Include the nearest real competitors so the test can expose confusion.

Cover the request shapes that matter for the target:

- direct requests;
- paraphrases and indirect requests;
- incomplete requests that should still start the workflow;
- requests owned by a competing skill;
- explanation-only requests that use similar words;
- unsupported work on the same product or file;
- other languages, shorthand, or typos when users commonly use them;
- important false activations.

Keep working and unseen cases separate. Write the unseen cases before reading variant results when possible.
Remove ambiguous cases instead of forcing one expected route.

## Create the experiment

`target` is the result label for the skill being tested. A variant may provide another `name`; the evaluator
maps its marker back to `target` when scoring.

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

The evaluator replaces each skill body with a fixed label, verifies the catalog, and runs Codex in a
read-only sandbox. It writes JSONL and `report.json` outside the repository by default.

## Compare variants

Test descriptions with the current name first:

1. Current description.
2. Core job only.
3. Core job plus the requests it should handle.
4. The prior version plus boundaries for observed false activations.

Test names only after one description works. Use the same description with the current name, useful
candidates, and one vague control.

Compare correct routes, missed target routes, false target routes, and where wrong requests went. Repeat
failures before drawing a conclusion, then run the winner against the unseen cases.
