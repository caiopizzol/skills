---
name: protect-gh-repo
description: Protect or check a GitHub default branch using checks already seen passing on real pull requests. Use only after CI has run successfully.
---

# Protect a GitHub repository

Require only rules the repository has already proved it can pass.

For a check-only request, report `ready`, `gap`, `not-applicable`, or `unverified` with evidence. Do not
change anything. Reading all active rules needs admin access. If any rule cannot be read, report
`unverified` and stop.

## Steps

1. Check the default branch, branch protection, repository and organization rulesets, recent pull
   requests, checks, reviews, and admin access.
2. Find the exact successful CI check and its GitHub App when available. Never guess.
3. Keep existing protection and make the smallest supported change. Follow
   [GitHub's API rules](references/github-api.md). Require pull requests, the observed CI check, and
   resolved conversations. Block force pushes and branch deletion.
4. Require approval only when a repository member or team can provide it without self-approval.
5. Read all active rules back. When possible, confirm a failing pull request is blocked. If approval is
   required, also confirm an unapproved pull request is blocked.

Do not create workflows, install review tools, weaken protection, or require an unproven check.
