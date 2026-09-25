---
name: create-gh-repo
description: Create a GitHub repository from an existing local Git repository, or check whether one is connected. Do not use for CI or merge protection.
---

# Create a GitHub repository

Keep the local repository as the source of truth.

For a check-only request, report `ready`, `gap`, `not-applicable`, or `unverified` with evidence. Do not
change anything.

## Steps

1. Check commits, the working tree, remotes, and the signed-in GitHub owner. Require at least one commit
   and a free remote name.
2. Confirm the owner, repository name, and visibility. Ask separately for permission to create it, make
   it public, and push.
3. Check the exact history and refs for secrets, private content, author details, and licensing. Fix and
   recheck any problem before pushing. Unclear licensing blocks a public repository, not a private one.
4. Create the repository without pushing. Use `origin` and `main` unless the user chose other names.
   Enable deletion of merged branches and read-only workflow permissions.
5. With approval, push only the chosen default branch. Read the settings back and confirm its GitHub SHA
   matches the intended local commit.

Do not rewrite project files or add CI, review tools, or merge protection.
