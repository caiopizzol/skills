---
name: setup-project
description: Create or check a project's tools, TypeScript, tests, and optional GitHub repository. Use for new Vite+ projects and incomplete or existing codebases.
---

# Set up a project

Coordinate the setup skills without copying their steps.

## Steps

1. Decide whether the user wants to create, check, or change a project. Include GitHub only when a remote
   points there or the user asks for it. A remote on another host is `not-applicable`, not a gap.
2. Ask the matching skills to check their areas: `$setup-vite-plus`, `$setup-typescript`, `$setup-tests`,
   and `$setup-gh-repo`.
3. Report each result, its evidence, and the proposed changes. Stop for a check-only request.
4. Otherwise add only what is missing, in that order. GitHub comes last because protection needs checks
   seen on a real pull request.
5. Run the root check. Report what changed and what remains unverified.

This skill creates only Vite+ projects. Require an empty target and use `$setup-vite-plus`, then run the
other skills in the same order. Report other stacks as unsupported.

A generator may create Git without a commit or on the wrong default branch. Set the intended branch and,
with permission, create the first commit before GitHub setup.

Follow each child skill's permission rules. If one is unavailable, report its area as `unverified`.
