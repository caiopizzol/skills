---
name: push-pr-stack
description: Push rewritten branches in an existing GitHub PR Stack as one guarded update. Use after local rebases when every branch already exists remotely and the exact old remote and new local SHAs are known.
---

# Push a pull request Stack

Require one remote and a guard for every branch. Each guard contains the branch name, local commit to push,
and remote commit seen before local changes. Never read a new remote SHA at push time and use it as permission
to overwrite that commit.

Run from the repository worktree:

```sh
bun --no-env-file <skill-directory>/scripts/push.ts \
  --remote origin \
  --branch feature/foundation <local-sha> <expected-remote-sha> \
  --branch feature/consumer <local-sha> <expected-remote-sha>
```

The script checks every branch and guard, runs one `git push --atomic`, and reads remote heads back. After a
failed push, use those heads, not Git's error text:

- Changed guard: `input-changed`.
- Unchanged guard: `provider-error`.
- Every requested commit already present: success.

For `input-changed`, reread and recheck the Stack. Do not retry with new guards. If the final read fails,
keep its result and both cleaned diagnostics. Do not guess from the push error.

## Return

Report the remote, each branch's old and pushed SHA, and one result: `ok`, `tool-unavailable`,
`unsupported-input`, `input-changed`, `timeout`, or `provider-error`.

## Rules

- Do not fetch, rebase, create branches, create or edit pull requests, change Stack membership, reply to
  reviews, mark pull requests ready, or merge.
- Do not push branches one at a time when the atomic push fails.
- Follow repository sign-in rules before running the script.
