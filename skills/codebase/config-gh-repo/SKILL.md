---
name: config-gh-repo
description: Configure or check GitHub merge settings and pull request cleanup. Use for squash merging, auto-merge, branch updates, and deleting merged branches. Do not use for CI or branch protection.
---

# Configure a GitHub repository

Change only merge and pull request settings.

For a check-only request, report `ready`, `gap`, `not-applicable`, or `unverified` with evidence. Do not
change anything.

## Steps

1. Check admin access, current settings, recent merges, and GitHub's current API fields.
2. Unless the repository says otherwise, propose squash-only merges. Use the pull request title for the
   commit title and no commit body. Enable auto-merge, branch update suggestions, and deletion of merged
   branches.
3. Keep unrelated settings unchanged. Change web commit signoff only for an explicit DCO policy.
4. Show exact before and after values. Get approval before changing GitHub, then send only these settings.
5. Read the settings back and report anything GitHub could not show or verify.

Do not change repository features, commit comments, Git LFS archives, preview push limits, workflows,
review tools, required checks, approvals, rulesets, or branch protection.
