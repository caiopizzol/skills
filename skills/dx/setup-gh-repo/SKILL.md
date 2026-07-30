---
name: setup-gh-repo
description: Create a GitHub repository from an existing local Git repository and apply minimal safe repository settings. Use when publishing or connecting a local project to a new GitHub repository, not when adding CI or required checks to an existing remote.
---

# Set up a GitHub repository

Keep the local repository as the source of truth.

## Workflow

1. Inspect the commits, working tree, remotes, and authenticated GitHub owner. Require at least one commit
   and a free remote name.
2. Confirm the owner, repository name, and visibility. Treat creating the repository, making it public,
   and pushing as separate actions unless already authorized.
3. Audit the exact history and refs that will be pushed for private material, credentials, author
   identity, and licensing.
4. Create the remote without pushing. Use `origin` and `main` unless the caller chose otherwise. Enable
   deletion of merged branches, read-only workflow permissions, and secret scanning when supported.
5. With explicit permission, push only the selected default branch. Verify the remote settings and
   commit match the intended local state.

Do not rewrite project files or add CI, releases, dependency automation, or templates. Leave checks and
merge enforcement to `setup-gh-checks`.
