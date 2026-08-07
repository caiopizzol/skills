---
name: monitor-pr
description: Monitor one exact GitHub pull request or its managed Stack until ready to merge. Use after initial implementation is complete to mark drafts ready, monitor current-head CI, conflicts, and configured bot feedback, delegate per-PR investigation and fixes, publish Stack changes safely, address validated review threads, and keep looping until clean or a human decision is required. Never merge.
---

# Monitor a pull request to ready

Require one exact `https://github.com/OWNER/REPOSITORY/pull/NUMBER` URL. Treat invocation as approval to
start review by marking the requested PR, or every open member of its managed Stack, ready. Require the
expected writer login and configured reviewer bot logins from the caller or repository-owned instructions
or configuration; never infer writer authority from the remote owner or guess an actor.

When the caller explicitly requests a dry run or read-only evaluation, do not treat invocation as mutation
authority. Build and report the exact work list, return `dry-run`, and leave repository and provider state
unchanged.

Read [the orchestration workflow](references/workflow.md) before acting.

## Coordinate one loop

1. Use `$watch-gh-pr` to discover the exact PR or managed Stack and record every current head SHA.
2. Keep one coordinator responsible for Stack order, GitHub identity, rebases, publication, and the
   authoritative head map. Do not assign permanent polling agents to individual PRs.
3. Mark open drafts ready only after rechecking their heads and the authenticated actor.
4. When work appears, assign at most one isolated worker per affected PR. Let that worker investigate
   all current CI failures and all old and new configured-bot feedback for that PR.
5. Require `$assess-gh-pr-feedback` before deciding that a review claim needs a fix, disagreement, reply,
   or resolution. Never infer clean feedback from a successful reviewer check.
6. Integrate fixes bottom-to-top, rebase affected upper branches, test the resulting Stack, and use
   `$push-gh-stack-atomically` for rewritten remote Stack branches.
7. After publication, use `$resolve-gh-pr-thread` to apply an evidence-backed reply, reaction, and
   resolution to each assessed unresolved bot thread at the exact published head.
8. Resume `$watch-gh-pr` and repeat until the terminal condition is established from a final unchanged
   head map.

## Stop condition

Return `ready-to-merge` only when every scoped PR is ready, linear and conflict-free; every observed
current-head CI and reviewer check and every explicitly configured expected check succeeded; GitHub's
merge state is clean; complete exact-head feedback assessment found no remaining fix, human decision, or
evidence gap; every configured-bot thread is addressed; and no worker remains active. Return the
supported non-ready outcome instead of weakening any condition.

## Boundaries

Never merge, queue, enable auto-merge, dismiss feedback, bypass requirements, or treat `NEUTRAL`, skipped,
missing, superseded, or stale-head checks as success. Serialize GitHub writers and use one writer per
thread. Treat the authenticated login as part of every evidence boundary: verify it immediately before
each provider mutation and read the mutation back before another writer acts. An unexpected identity
change makes the operation indeterminate. A lower Stack change invalidates every affected upper-head
assessment; reassess rather than carrying conclusions forward.
