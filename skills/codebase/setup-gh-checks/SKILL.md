---
name: setup-gh-checks
description: Add, update, or check a small GitHub Actions workflow that runs the repository's existing check command. Do not use for merge protection.
---

# Set up GitHub checks

Run the repository's existing checks on GitHub. Do not choose or install new quality tools.

For a check-only request, report `ready`, `gap`, `not-applicable`, or `unverified` with evidence. Do not
change anything.

## Steps

1. Check the default branch, package manager, root scripts, and current workflows.
2. Confirm one root command runs formatting, linting, type checking, and tests without writing files. Run it
   locally.
3. Work on a non-default branch. Update `.github/workflows/check.yml` without removing useful jobs or
   changing check names already used by GitHub.
4. If no validation job exists, add one on `ubuntu-latest` with stable names, readable action versions, a
   frozen install, and the root check command. Reuse runtime versions declared by the repository. Allow only
   `contents: read`. Never use `pull_request_target`, secrets, write access, or automatic fixes.
5. When used alone, open or update a pull request with permission. Under a parent skill, return the prepared
   change. Wait for the job and record its exact successful check name and GitHub App when available.

Do not configure merge protection or add unrelated tools.
