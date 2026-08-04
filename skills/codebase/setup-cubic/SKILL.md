---
name: setup-cubic
description: Set up, simplify, or assess Cubic AI code review for a GitHub repository. Use when enabling Cubic, auditing whether it reviews this repository, or creating the smallest useful repository-owned cubic.yaml from existing project guidance.
---

# Set up Cubic

Start with Cubic's defaults and add only repository-specific review guidance.

When the caller requests an assessment, report this capability as ready, gap, not-applicable, or
unverified with the evidence for it, then stop before changing anything.

## Workflow

1. Read `https://docs.cubic.dev/llms.txt` and `https://cubic.dev/schema/cubic-repository-config.schema.json`. They override remembered fields and defaults.
2. Inspect any existing `cubic.yaml` and the repository's README, agent instructions, and relevant project documentation. Do not overwrite an existing configuration without approval.
3. Confirm the Cubic GitHub app is installed for the repository. Treat installing the app or changing dashboard settings as separate permissions.
4. Work on a non-default branch. Create or reconcile the smallest valid `cubic.yaml`. Keep `version: 1`; set only repository-owned overrides and account for omitted fields inheriting organization YAML, dashboard settings, then defaults. Write no file when inherited behavior is sufficient.
5. Add short custom instructions only for a demonstrated review gap absent from both deterministic checks and Cubic's auto-detected repository context. Do not copy existing guidance merely because it is not enforced deterministically. Add no custom agents unless a demonstrated review gap requires one.
6. When a file is needed, validate it against the live schema. When invoked alone, open or update a pull request with permission; under a composite, return the prepared change to its parent. After the pull request exists, confirm Cubic accepts the YAML without a settings error and reviews it when the app is available. Otherwise, report that inherited behavior is sufficient and make no change.

Do not require Cubic as a merge status by default or copy general project documentation into its configuration.
