---
name: setup-gh-repo
description: Set up or check a GitHub repository's merge settings, CI, Cubic review, and branch protection. Use a child skill when only one area is needed.
---

# Set up a GitHub repository

Coordinate the GitHub setup skills. Do not copy their steps here.

For a check-only request, ask each matching child skill to check its area. Report `ready`, `gap`,
`not-applicable`, or `unverified` with evidence, then stop.

## Steps

1. Use `$create-gh-repo` when the local project is not connected to GitHub.
2. Ask every matching child to check first. If all are ready, report no change and stop.
3. Use `$config-gh-repo` for merge settings. Create or reuse one non-default setup branch, then use
   `$setup-gh-checks` and `$setup-cubic` on it. This skill owns the shared branch and pull request.
4. With permission, push and open one draft pull request. Wait for CI. If Cubic does not review drafts,
   get separate permission before marking it ready.
5. With explicit permission, merge after required checks and reviews pass. Confirm the default branch has
   the changes.
6. Use `$protect-gh-repo` with the check names and review paths seen on that pull request. Require Cubic
   only when its child skill proves both the review and App check.

Follow each child skill's permission rules. If one is unavailable or cannot verify its result, stop that
part and report the gap.
