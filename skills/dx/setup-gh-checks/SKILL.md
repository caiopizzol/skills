---
name: setup-gh-checks
description: Add or reconcile a minimal GitHub Actions validation workflow and require its successful status on the default branch. Use when a GitHub repository already has one local non-writing check command covering formatting, linting, and type checking.
---

# Set up GitHub checks

Run the repository's existing validation in GitHub. Do not choose or install quality tools.

## Workflow

1. Inspect the default branch, package manager, root scripts, workflows, and existing merge protection.
   Confirm `gh` can administer the repository.
2. Confirm one root, non-writing check command covers formatting, linting, and type checking, then run it.
3. Create or reconcile `.github/workflows/check.yml` for pull requests and default-branch pushes. Use
   `contents: read`, one `ubuntu-latest` job, readable action versions, a frozen install, and the root
   check command. Never use `pull_request_target`, secrets, write permissions, or automatic fixes.
4. With permission, open or update a pull request. Wait for GitHub to report the job before requiring its
   exact status context.
5. Preserve existing protections. Require pull requests, the observed check, and resolved conversations;
   block force pushes and deletion. Add approvals or strict updates only when requested.
6. Read the settings back and confirm the pull-request head passed and the required check blocks merging.

Do not add or configure other quality, release, deployment, or repository-management tools.
