---
name: improve-skill
description: Test and improve a skill's name and description with real Codex routing results. Use when a skill activates for the wrong requests, misses requests it should handle, or may need a new name. Do not use to rewrite the skill's steps or test what it does after activation.
---

# Improve skill metadata

Use routing evidence instead of guessing.

## Test

1. Read the target `SKILL.md`, its direct references, and the names and descriptions of the most similar
   skills in the full active catalog, including skills outside the target repository. Do not run any skill.
2. Read [the evaluation guide](references/evaluation.md). Write test requests with their expected results.
   Split them into working and unseen sets before drafting other names or descriptions.
3. Create the experiment JSON outside the repository. Keep the skill body fixed. With the current name,
   test different descriptions first.
4. Run:

   ```sh
   bun --no-env-file <skill-directory>/scripts/evaluate.ts \
     <experiment.json> --model <model> --repetitions 1
   ```

5. Repeat each failure and important boundary case at least twice. Keep `tool-unavailable`, `timeout`,
   `runtime-error`, and `invalid-output` separate from a valid `none` result.
6. Change the description only when a result shows a missed or wrong route. Test names only after the
   description works. Keep that description fixed for every name.
7. Test the winner against the unseen requests. Reject a change that fixes missed routes by adding false
   activations, or the reverse.
8. Change only the name or description supported by the results. If the name changes, update the folder,
   references, catalog links, and `agents/openai.yaml`. Run the repository's full check.
9. Report the model, Codex version, cases, repetitions, results, gaps, and artifacts directory. Do not commit
   raw run output.

## Rules

- Score the fixed labels exactly. Do not ask another model to judge the result.
- Test only which skill activates. Never run the production workflow during the test.
- Do not turn one result into a general rule.
- Do not add details to the description unless a routing failure shows they are needed.
