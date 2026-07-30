---
name: setup-gh-repo
description: Set up a GitHub repository with CI, Cubic code review, and safe merge protection. Use for the complete GitHub setup; use a child skill directly for only one capability.
---

# Set up a GitHub repository

Compose the GitHub setup without recreating any child's procedure.

## Workflow

1. Use `$create-gh-repo` when the local project is not connected to GitHub.
2. Inspect every child first. If all are compliant, report no change and stop.
3. Otherwise, create or reuse one non-default bootstrap branch, then use `$setup-gh-checks` and `$setup-cubic` on it. The composite owns the shared branch and pull request.
4. With permission, push and open one draft pull request. Wait for CI. When Cubic is available but does not review drafts, get separate permission to mark the pull request ready before waiting for its review.
5. Use `$protect-gh-repo` with the successful CI context and reviewer paths observed on GitHub. Cubic is optional and is not a required status by default.

Honor each child's permission boundaries. If a child is unavailable or cannot verify its result, stop that capability and report the gap.
