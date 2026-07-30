---
name: setup-gh-repo
description: Create a GitHub repository from an existing local Git repository and apply minimal safe repository settings. Use when publishing or connecting a local project to a new GitHub repository, not when adding CI or required checks to an existing remote.
---

# Set up a GitHub repository

Keep the local repository as the source of truth. Do not generate or rewrite project files.

## Create

1. Inspect the current branch, commits, working tree, and remotes. Confirm `gh` is authenticated as the
   intended owner. Stop if the requested repository already exists or `origin` points elsewhere.
2. Require an explicit owner, repository name, and visibility. Treat creating the remote, pushing, and
   making it public as separate external actions; proceed only when the request authorizes each one.
3. Before public creation or visibility, audit the exact tree, every commit and ref that will be pushed,
   and their metadata for credentials and private material. Confirm the license and intended author
   identity. Do not treat `.gitignore` or a clean working tree as proof.
4. Require an existing local Git repository with at least one commit. Do not invent a README, license,
   `.gitignore`, initial commit, or project description.
5. Read the installed `gh repo create --help` and `gh repo edit --help`, then create the remote from the
   current repository without `--push`. Use `origin` unless the caller chose another remote name.
6. Use `main` for a new repository. If the local branch has another name, ask before renaming it.
7. Apply only these defaults when supported:
   - Delete head branches after merge.
   - Give workflow tokens read-only permissions and prevent them from approving pull requests.
   - Enable secret scanning, verify it, then enable push protection.
8. Push only the intended default branch when explicitly authorized. Do not push tags or other refs
   without separate authorization. Verify the remote URL, visibility, default branch, settings, and
   local-to-remote commit identity through GitHub after the push.

Report every setting GitHub or the current plan does not support. Do not report the repository ready
when the remote is empty or differs from the intended local commit.

## Boundaries

Do not change an existing repository's visibility, merge methods, features, topics, or collaborators.
Do not add workflows, branch protection, releases, dependency automation, or repository templates.
Leave CI and merge enforcement to `setup-gh-checks`.
