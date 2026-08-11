---
name: setup-changesets
description: Set up Changesets for package releases, changelogs, tags, GitHub Releases, and optional registry publishing.
---

# Set up Changesets

Add reviewed package releases without assuming they publish to a registry.

## Steps

1. Identify the packages and release target: GitHub, a registry, or both. Keep package visibility. If the
   user wants one version for the whole repository, explain that Changesets may not fit.
2. Install stable `@changesets/cli` and run `changeset init`. Keep `.changeset/config.json`, set
   `baseBranch`, and preserve registry access. For GitHub-only releases, enable versioning and tags for
   private packages.
3. Add root commands to create changesets, update versions, and publish.
4. Confirm the release credential can create and update pull requests and trigger every required check
   and review. The default `GITHUB_TOKEN` cannot trigger workflows from its own pull requests. Check
   current GitHub docs before asking for another credential, and state the exact permissions needed.
   Stop if it is unavailable. Add `changesets/action@v1` to default-branch pushes and verify its inputs
   against the current `action.yml`. Require registry login only when publishing there.
5. Check remote tags. Test the first version and tag run in a disposable repository because it tags each
   private package version that has no tag. Show the exact versions, changelogs, and tags. Get approval
   before committing, pushing, or opening a pull request, then run the repository check.
