---
name: resolve-pr-thread
description: Reply to, react to, and resolve one already-checked GitHub pull request review thread. Use after the finding is verified and any needed fix is pushed. Do not use for general comments or code changes.
---

# Resolve one GitHub PR thread

Require an evidence-based reply, chosen reaction, expected GitHub account, permission to resolve, and the
reviewed pull request head SHA. Do not cross a new push.

Run:

```sh
bun --no-env-file <skill-directory>/scripts/resolve.ts \
  --pr https://github.com/OWNER/REPOSITORY/pull/NUMBER \
  --thread-id <graphql-thread-id> \
  --root-comment-id <numeric-root-review-comment-id> \
  --expected-head-sha <assessed-pr-head-sha> \
  --expected-actor <github-login> \
  --reply-file <path-to-utf8-reply> \
  --reaction +1 \
  --resolve
```

Use `-1` only when the user chose it. The script never decides whether the finding is valid.

The script uses only `github.com`, checks the account and exact thread, root comment, and pull request, then
reads each change back. GitHub cannot apply reply, reaction, and resolution together. After a known partial
failure, rerun the exact request to add only missing steps. Keep an already-resolved thread resolved.

## Results

- `ok`: verified complete.
- `partial`: applied steps are known; retry the same inputs after GitHub recovers.
- `indeterminate`: inspect the thread before retrying because the result could not be read.
- `input-changed`: verify the finding again before using a new head SHA.

## Rules

- Use one writer per thread. Two writers can still duplicate replies.
- Do not run beside a process that can call `gh auth switch`. `gh api` cannot choose an account per call.
- Do not assess findings, edit code, commit, push, rebase, change Stack membership, mark a pull request
  ready, merge, or touch issue comments.
