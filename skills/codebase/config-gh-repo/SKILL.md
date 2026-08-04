---
name: config-gh-repo
description: Configure or assess a GitHub repository's merge strategy and pull-request housekeeping. Use for squash merging, auto-merge, branch updates, and deleting merged branches, not CI or branch protection.
---

# Configure a GitHub repository

Apply a small repository-level pull-request policy without changing merge gates.

When the caller requests an assessment, report this capability as ready, gap, not-applicable, or
unverified with the evidence for it, then stop before changing anything.

## Workflow

1. Inspect the repository, administration access, current settings, recent merge history, and GitHub's current API fields.
2. Unless established repository policy says otherwise, propose squash-only merging with the pull-request title as the commit title and no commit body. Enable auto-merge, update-branch suggestions, and automatic deletion of merged branches.
3. Preserve settings outside that policy. Change web commit signoff only when the repository has an explicit DCO policy. Do not manage repository features, commit comments, Git LFS archives, or preview push limits.
4. Show the exact before-and-after values and get explicit approval before changing GitHub. Send only the owned settings through a supported API.
5. Read every owned setting back and report any option GitHub could not expose or verify.

Do not configure workflows, review tools, required checks, approvals, rulesets, or branch protection.
