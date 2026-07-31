---
name: setup-changesets
description: Set up Changesets for public or private packages with release pull requests, changelogs, tags, GitHub Releases, and optional registry publishing. Use when adding package-level release automation.
---

# Set up Changesets

Add reviewed package releases without assuming they publish to a registry.

## Workflow

1. Identify the release packages and destination: GitHub, a registry, or both. Do not change package
   visibility. If the caller wants one repository-wide version unrelated to packages, report that
   Changesets may not fit.
2. Install stable `@changesets/cli` and run `changeset init`. Keep the generated
   `.changeset/config.json`, set `baseBranch` to the default branch, and preserve registry access. For
   GitHub-only releases, set `privatePackages.version` and `privatePackages.tag` to `true`.
3. Add root commands for creating changesets, versioning, and publishing.
4. Confirm the release credential can create pull requests and trigger every required check and review;
   the default `GITHUB_TOKEN` cannot trigger workflows from its own pull requests. Before requesting
   another credential, query current GitHub documentation and tell the user exactly which repository
   permissions and access levels to select. Stop if unavailable. Add `changesets/action@v1` on
   default-branch pushes with the publish command; require registry authentication only for registry
   publication.
5. Inspect remote tags: the first publish tags every private package version without one. Reproduce the
   first version-and-tag cycle in a disposable repository. Show the exact versions, changelogs, and tags,
   and get approval before committing, pushing, or opening a pull request. Then run the repository check.
