---
name: improve-skill-metadata
description: Test and improve a skill's name and description using real Codex routing results. Use when a skill activates for the wrong requests, misses requests it should handle, or when deciding whether to rename it. Do not use to rewrite the skill body or test how its workflow runs.
---

# Improve skill metadata

Use routing evidence instead of guessing.

## Test

1. Read the target `SKILL.md`, its direct references, and the names and descriptions of its nearest
   competing skills. Do not run their workflows.
2. Read [the evaluation guide](references/evaluation.md). Write labeled test requests and a separate set of
   unseen requests before writing metadata variants.
3. Create the experiment JSON outside the repository. Keep the skill body fixed and test description
   variants with the current name first.
4. Run:

   ```sh
   bun --no-env-file <skill-directory>/scripts/evaluate.ts \
     <experiment.json> --model <model> --repetitions 1
   ```

5. Repeat every failure and close call at least twice. Keep evaluator failures separate from a valid result
   where no skill was selected.
6. Improve the description only when a result shows what it missed or confused. Test names only after the
   description works, and keep that description fixed for every name.
7. Test the winner against the unseen requests. Reject a change that fixes missed routes by adding false
   activations, or the reverse.
8. Update only the metadata supported by the results. If the name changes, update the folder, skill
   references, catalog links, and `agents/openai.yaml`. Run the repository's full check.
9. Report the model, Codex version, cases, repetitions, results, gaps, and artifacts directory. Do not commit
   raw run output.

## Rules

- Score exact markers. Do not use an LLM to judge the result.
- Measure routing only. Never run the production workflow during the test.
- Do not turn one result into a general rule.
- Do not add details to the description unless a routing failure shows they are needed.
