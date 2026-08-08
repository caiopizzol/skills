---
name: monitor-pr
description: Monitor one exact GitHub pull request or its managed Stack until ready to merge. Use after initial implementation is complete to assign one persistent worker per PR that marks it ready, monitors current-head CI, conflicts, and configured bot feedback, investigates and fixes valid problems, publishes safely, replies, reacts, resolves threads, and keeps looping until clean or a human decision is required. Never merge.
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

## Coordinate PR owners

1. Run the bundled snapshot collector to discover the exact PR or managed Stack and record every current
   head SHA.
2. Assign one persistent sub-agent owner to every scoped PR. Run owners in capacity-limited waves and
   reactivate the same owner for later events; never split one PR across comment-specific workers.
3. Keep the coordinator as a control plane only: preserve Stack order and the authoritative head map,
   schedule bottom-to-top publication turns, and aggregate worker results. After dispatch, do not inspect
   technical feedback, edit code, publish branches, or address conversations on a worker's behalf.
4. Require each worker to own its complete loop: mark ready, observe only its PR, use `$read-github-pr`,
   reproduce every claim, fix and test valid problems, publish its changes, use `$resolve-pr-thread`, and
   resume monitoring the resulting head.
5. Grant only one exclusive Stack publication turn at a time. The owning worker integrates its own fix,
   rebases affected upper branches, tests the resulting Stack, and invokes `$push-pr-stack`; the
   coordinator never performs those steps for it.
6. Establish readiness only from clean worker reports bound to one final unchanged Stack head map.

## Stop condition

Return `ready-to-merge` only when every scoped PR is ready, linear and conflict-free; every observed
current-head CI and reviewer check and every explicitly configured expected check succeeded; GitHub's
merge state is clean; complete exact-head feedback assessment found no remaining fix, human decision, or
evidence gap; every configured-bot thread is addressed; and no worker remains active. Return the
supported non-ready outcome instead of weakening any condition.

## Boundaries

Never merge, queue, enable auto-merge, dismiss feedback, bypass requirements, or treat `NEUTRAL`, skipped,
missing, superseded, or stale-head checks as success. Serialize Stack rebases and publication, but allow
different workers to investigate and address disjoint threads concurrently. Use one writer per thread.
Pin one shared GitHub CLI configuration and expected actor for the run; verify the actor immediately
before every provider mutation and read the mutation back. An unexpected identity change makes the
operation indeterminate. A lower Stack change invalidates every affected upper worker's assessment;
reactivate that owner at the new head instead of carrying conclusions forward.
