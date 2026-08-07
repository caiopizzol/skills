# PR monitoring workflow

## Preflight and ownership

1. Resolve the expected writer login from the caller or repository-owned instructions. Never use the
   remote owner as authority. Follow an explicit repository account-switch requirement before starting,
   then pin one shared GitHub CLI configuration for every worker. If no expected writer is established,
   return `human-decision` before any mutation.
2. Run `bun --no-env-file <skill-directory>/scripts/snapshot.ts <pull-request-url>` once to discover a
   standalone PR or every open member of its managed Stack in bottom-to-top order. Record the remote head
   of every member.
3. Assign one persistent logical owner to every scoped PR. Start as many owners as agent capacity permits
   and queue the rest. A waiting owner may yield and later be reactivated, but keep the same canonical
   worker responsible for that PR unless it becomes unavailable.
4. Give each owner its exact PR URL and head, configured reviewer logins and expected checks, detached
   investigation worktree, artifacts directory, shared authenticated configuration, and the exclusive
   mutable Stack worktree it may use only during a granted publication turn.

The coordinator owns only membership, order, worker capacity, the current head map, and publication-turn
scheduling. It may take a final Stack snapshot to compare structure and heads with worker reports. After
dispatch it must not inspect feedback, diagnose checks, edit code, push, request reviews, reply, react, or
resolve on a worker's behalf.

Draft status is a review lifecycle signal, not a CI switch. CI may run on drafts. Each worker marks its own
open draft ready only after rechecking its exact head and authenticated actor. Never enable auto-merge;
GitHub does not support auto-merge for stacked pull requests.

## Worker-owned loop

Each PR owner repeats the following loop until it can report clean at one unchanged head:

1. Run `bun --no-env-file <skill-directory>/scripts/snapshot.ts <pr-url> --pr-only` to observe only the
   assigned PR. Verify the authenticated account, provider head, and detached worktree head. Treat any
   mismatch as `input-changed` and restart from the new assigned head.
2. Establish the expected check set from caller instructions or explicit repository configuration when
   one exists. Identify each expected check as `{ workflow, name }`, using `null` for an external check.
   Retain duplicate older runs as superseded evidence. Never collapse checks that only share a name.
3. Use `$read-github-pr` for complete retrieval. Enumerate every configured-bot issue comment, review
   summary, and inline thread, including old, resolved, and outdated feedback. Exact-login matching is
   required. Split independent technical claims and deduplicate repeated claims locally.
4. Reproduce every concrete review claim and failing current-head CI check with the smallest existing
   command or a temporary reproducer beneath the artifacts directory. Inspect implementation, tests,
   configuration, diff, and surrounding behavior. A failed reproduction alone does not disprove a claim,
   and a successful reviewer check does not prove there are no comments.
5. Classify each claim as `valid-fixable`, `invalid`, `already-addressed`, `informational`,
   `human-decision`, or `provider-gap`. Distinguish code defects, deterministic configuration failures,
   transient infrastructure failures, product decisions, and evidence gaps.
6. For a valid fix, edit only the assigned detached worktree, run focused checks, and create concise
   conventional commits. For every unresolved thread, prepare a response that states the classification,
   evidence, change or rationale, and tests run.
7. Request a publication turn when a code or conflict fix is ready. Do not ask the coordinator to apply
   the commit or perform any provider mutation. Continue read-only investigation while another worker
   holds the turn, but do not publish concurrently.
8. After the worker publishes or confirms that no publication is required, address its own assessed
   threads and resume this loop. Wait without busy-polling and never hold one blocking wait longer than
   60 seconds.

Open or refresh work whenever an observed or expected check is non-successful, complete feedback has not
covered the current head, the PR is conflicted or non-linear, its lower Stack branch changed, reviewer
metadata changed, or a configured-bot thread remains unresolved. Do not treat `NEUTRAL`, skipped, missing,
or an older successful run as current success.

## Exclusive publication turn

Grant waiting turns bottom-to-top. Only the granted PR owner may mutate the shared Stack worktree or remote
branches until it releases the turn.

While holding the turn, the same worker must:

1. Verify the authenticated actor and compare every current remote Stack head with the coordinator's
   granted lease map. On any difference, make no mutation, release the turn as `input-changed`, and restart
   the affected worker assessments. Never replace a rejected lease with a freshly discovered one.
2. Apply its prepared commits to the owning PR branch. Cascade-rebase every affected upper branch with
   non-interactive `gh stack rebase` commands. If a conflict requires a semantic change in another PR,
   stop and return that conflict to the other PR's owner instead of authoring its fix.
3. Run focused checks and the complete repository check at the top of the resulting Stack. Compare every
   branch ref with `gh stack view --json`; reconcile local boundary drift with a non-interactive
   `gh stack rebase --no-trunk` before publication.
4. Invoke `$push-pr-stack` itself for every rewritten existing branch, using the exact pre-mutation remote
   heads as leases. Never fall back to sequential pushes. For a standalone PR, prefer a fast-forward push;
   bind any rewritten push to its previously observed remote head.
5. Read every pushed remote head back, report the new map to the coordinator, and release the turn. The
   publication invalidates all affected upper workers; reactivate their existing owners at the new heads.
6. Observe its exact published PR again before addressing feedback. If its own head changed unexpectedly,
   return `input-changed` instead of crossing the new evidence boundary.

Publication is serialized; worker ownership is not transferred. Investigation, tests, and conversation
writes on different PRs may remain parallel. Use one writer per thread and serialize with any process that
can switch the shared GitHub identity.

When a configured reviewer deliberately skips rewritten history, the worker that published its PR may
request a new review only when the current-head reviewer check is absent or terminal-neutral. Never post a
duplicate while a request or check is queued, in progress, or successful. For Cubic, the repository-tested
request is:

```text
@cubic-dev-ai review this PR after the Stack rebase.
```

Read the request and subsequent check back; posting the command alone does not prove review ran.

## Worker-owned conversations

The same worker that assessed a thread must close its lifecycle after any required fix is published:

1. Recheck the exact PR head and authenticated actor.
2. Use `$resolve-pr-thread` with the exact thread ID, root comment ID, expected head, expected actor, reply
   file, `+1` acknowledgment, and explicit resolution authority. Use `-1` only when the caller selected it.
3. Read back the reply, reaction, and resolution. Respect `partial`, `indeterminate`, and `input-changed`;
   never retry blindly.
4. If the reviewer already resolved the thread, preserve that state while adding any missing reply and
   reaction. Still reassess old resolved and outdated findings at the current head.

The coordinator must never perform these steps for a worker.

## Terminal evaluation

Each worker reports `clean` only when, at one stable exact head:

- its PR is open and not a draft;
- its branch is linear, mergeable, and conflict-free;
- every observed current-head CI and reviewer check and every explicitly expected check succeeded;
- no check is neutral, skipped, missing, pending, cancelled, timed out, or superseded-only;
- every configured-bot conversation lane is complete with no retrieval or assessment gap;
- every configured-bot finding is invalid, already addressed, or informational;
- every thread that required action has the worker's verified reply and reaction and is resolved;
- GitHub's merge state is clean; and
- no human decision, external approval, provider gap, or local work remains.

The coordinator returns `ready-to-merge` only after every owner reports clean and one final Stack snapshot
matches every reported head, preserves bottom-to-top order, and shows no conflict or non-linearity. It must
route any discrepancy back to the existing PR owner rather than diagnose or fix it.

Otherwise keep the owning worker loop active or return one explicit outcome: `dry-run`, `input-changed`,
`indeterminate`, `human-decision`, `blocked`, `tool-unavailable`, `timeout`, `unsupported-input`, or
`provider-error`. Never merge as part of this skill.
