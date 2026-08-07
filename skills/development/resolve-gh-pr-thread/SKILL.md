---
name: resolve-gh-pr-thread
description: Reply to, react to, and resolve one already-assessed GitHub pull request review thread with exact identity and head-SHA guards. Use after a finding has been independently validated and any required fix has been published. Do not use to assess feedback, edit code, push branches, or handle general PR comments.
---

# Resolve one GitHub PR review thread

Require the caller's evidence-based reply, reaction decision, expected actor, and explicit resolution
authorization. Bind the operation to the assessed PR head SHA so a decision cannot silently cross a
new push.

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

Use `-1` only when the caller explicitly chose that reaction. The script never decides whether the
finding is valid.

The script pins all calls to `github.com`, verifies the authenticated actor and exact thread/root/PR,
then reads back after each mutation. GitHub does not make reply, reaction, and resolution atomic, so
the same exact request reconciles already-applied steps after a known partial failure without adding
an identical reply or reaction again.

## Outcomes

Treat `ok` as verified completion. `partial` records confirmed applied steps and may be retried with
the same inputs after the provider recovers. For `indeterminate`, inspect the exact thread before any
retry because GitHub's result could not be read back. Reassess on `input-changed`; do not substitute a
fresh head SHA without validating the finding again.

## Boundaries

Use one writer per thread. Provider mutations have no compare-and-swap primitive, so concurrent
writers can still duplicate replies after simultaneous preflight reads. Do not assess findings, edit
code, commit, push, rebase, change Stack membership, mark a PR ready, merge, or touch issue comments.
