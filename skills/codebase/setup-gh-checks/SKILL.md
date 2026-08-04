---
name: setup-gh-checks
description: Add, reconcile, or assess a minimal GitHub Actions validation workflow for a repository with one existing local check command. Use to run formatting, linting, type checking, and tests in CI, or to audit whether they run, not to configure merge protection.
---

# Set up GitHub checks

Run the repository's existing validation in GitHub. Do not choose or install quality tools.

When the caller requests an assessment, report this capability as ready, gap, not-applicable, or
unverified with the evidence for it, then stop before changing anything.

## Workflow

1. Inspect the default branch, package manager, root scripts, and existing workflows.
2. Confirm one root, non-writing check command covers formatting, linting, type checking, and tests, then run it locally.
3. Work on a non-default branch. Reconcile `.github/workflows/check.yml` without removing useful jobs or observed status contexts.
4. When no validation job exists, add one on `ubuntu-latest` with stable names, readable action versions, a frozen install, and the root check command. Do not copy a runtime or package-manager version when the setup action already reads the repository's declaration. Require effective `contents: read`; a verified repository default is sufficient when the workflow and job do not broaden it. Never use `pull_request_target`, secrets, write permissions, or automatic fixes.
5. When invoked alone, open or update a pull request with permission; under a composite, return the prepared change to its parent. After the pull request exists, wait for GitHub to report the job and record its exact successful context and producing GitHub App when available.

Do not configure merge protection or add unrelated repository tooling.
