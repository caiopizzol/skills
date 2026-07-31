---
name: setup-changesets
description: Set up Changesets for a publishable package or workspace with release pull requests from the default branch. Use when adding package versioning, changelogs, or automated publishing.
---

# Set up Changesets

Add reviewed releases for packages already intended for publication.

## Workflow

1. Confirm at least one package is publishable. Do not change package visibility or invent entry points.
2. Install stable `@changesets/cli` and run `changeset init`. Keep the generated
   `.changeset/config.json`, set `baseBranch` to the default branch, and preserve the package's existing
   access policy.
3. Add root commands for creating changesets, versioning, and publishing.
4. Add `changesets/action@v1` on pushes to the default branch. Enable publishing only when registry
   authentication exists.
5. Run the repository check and verify the release workflow.
