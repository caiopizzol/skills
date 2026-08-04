---
name: create-gh-repo
description: Create a GitHub repository from an existing local Git repository and connect its remote, or assess whether one is connected. Use when a local project has no GitHub repository yet, not when adding CI or merge protection.
---

# Create a GitHub repository

Keep the local repository as the source of truth.

When the caller requests an assessment, report this capability as ready, gap, not-applicable, or
unverified with the evidence for it, then stop before changing anything.

## Workflow

1. Inspect the commits, working tree, remotes, and authenticated GitHub owner. Require at least one commit and an available remote name.
2. Confirm the owner, repository name, and visibility. Treat creation, public visibility, and pushing as separate permissions.
3. Audit the exact history and refs to be pushed for secrets, private material, author identity, and licensing. Do not push secrets or material inappropriate for the chosen visibility; remediate and re-audit first. Missing or unclear licensing blocks public visibility, not private creation.
4. Create the repository without pushing. Use `origin` and `main` unless the caller chose otherwise. Enable merged-branch deletion and read-only workflow permissions.
5. With explicit permission, push only the selected default branch. Read the repository settings back, then compare the GitHub branch head SHA with the intended local commit.

Do not rewrite project files or add CI, review tools, or merge protection.
