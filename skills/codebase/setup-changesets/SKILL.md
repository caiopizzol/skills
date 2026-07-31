---
name: setup-changesets
description: Set up or simplify Changesets for a publishable package or workspace with reviewed version pull requests and releases from the default branch. Use when adding package versioning, changelogs, or automated npm publishing, not when making a package publishable.
---

# Set up Changesets

Create the smallest reviewed release path. A releasable change updates a version pull request; merging
that pull request publishes it.

## Workflow

1. Inspect the package manager, default branch, package manifests, and existing release automation.
   Identify packages already intended for publication. Stop when none has a clear publication contract;
   do not remove `private`, choose registry access, or invent package entry points.
2. Install the current stable `@changesets/cli` v2; do not copy unreleased v3 configuration. Initialize
   Changesets, retain its defaults, and set `baseBranch` to the repository's default branch.
3. Add root commands for creating changesets, versioning packages, and publishing them. Include an
   existing build step in the publish command only when published packages require it.
4. Add one release workflow on pushes to the default branch. Use the existing package manager, a frozen
   install, readable action versions, least privilege, and `changesets/action@v1` to maintain the version
   pull request. Enable its publish command only after registry authentication is verified; otherwise
   leave publishing disabled and report that gap.
5. Run the repository check and `changeset status`. Inspect each publishable package's packed contents
   before enabling publication.

Add changesets for changes consumers receive. Do not require them for documentation, tests, CI, or
other non-release work. Do not add preview publishing, release channels, custom changelog plugins, or
changeset-enforcement checks until the repository needs them.
