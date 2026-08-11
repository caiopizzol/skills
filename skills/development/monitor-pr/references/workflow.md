# PR monitoring workflow

## Start

1. Get the expected writer from the user or repository instructions. Follow any required account switch,
   then pin one shared GitHub CLI configuration. If no writer is known, return `human-decision` before any
   change.
2. Run:

   `bun --no-env-file <skill-directory>/scripts/snapshot.ts <pull-request-url>`

   Record a standalone pull request or every open Stack member from bottom to top, with each remote head.

3. Give each pull request one persistent owner. Run as many as capacity allows and queue the rest. Reuse the
   same owner unless it becomes unavailable.
4. Give each owner its URL, head, reviewer logins, expected checks, detached worktree, artifacts directory,
   shared GitHub configuration, and the Stack worktree it may use only during its publication turn.

The coordinator owns only membership, order, capacity, head SHAs, publication turns, and final comparison.
After assigning owners, it must not inspect feedback, diagnose checks, edit code, push, request reviews, or
close threads for them.

Each owner marks its open draft ready only after checking its head and account. Never enable auto-merge.

## Owner loop

Repeat until the pull request is clean at one unchanged head:

1. Run `bun --no-env-file <skill-directory>/scripts/snapshot.ts <pr-url> --pr-only`. Check the account,
   remote head, and detached worktree head. On mismatch, return `input-changed` and restart at the assigned
   head.
2. Read expected checks from the user or repository configuration. Identify each as `{ workflow, name }`;
   use `null` workflow for an outside check. Keep older duplicate runs as superseded. Do not merge checks
   that only share a name.
3. Use `$read-github-pr`. Include every configured-bot issue comment, review summary, and inline thread,
   including old, resolved, and outdated items. Match exact bot logins. Split separate claims and remove
   local duplicates.
4. Reproduce each concrete claim and failing current-head check with the smallest existing command or a
   temporary reproducer in the artifacts directory. Check the code, tests, configuration, diff, and nearby
   behavior. Failed reproduction does not disprove a claim. A successful bot check does not prove there are
   no comments.
5. Classify each claim as `valid-fixable`, `invalid`, `already-addressed`, `informational`,
   `human-decision`, or `provider-gap`. Separate code bugs, repeatable configuration failures, temporary
   service failures, product decisions, and missing evidence.
6. For a valid fix, edit only the assigned detached worktree, run focused checks, and make short
   conventional commits. For each unresolved thread, prepare a reply with its classification, evidence,
   change or reason, and tests.
7. Request a publication turn for a code or conflict fix. Keep investigating read-only while waiting, but
   do not publish. Never ask the coordinator to apply the commit or change GitHub for you.
8. After publishing, or confirming no push is needed, close assessed threads and restart this loop. Wait
   without busy polling and never block longer than 60 seconds.

Reopen work when a current or expected check is not successful, current-head feedback is incomplete, the
branch is conflicted or non-linear, a lower Stack branch changed, reviewer data changed, or a configured-bot
thread remains unresolved. Neutral, skipped, missing, or old successful checks are not success.

## Publication turn

Grant turns from the bottom of the Stack upward. Only that owner may change the Stack worktree or remote
branches until the turn ends.

The owner must:

1. Check the account and every remote Stack head against the granted guard map. On any change, make no
   update, release the turn as `input-changed`, and restart affected reviews. Never replace a rejected guard
   with a newly read one.
2. Apply its commits to its branch. Rebase affected upper branches with non-interactive `gh stack rebase`.
   If a conflict needs a behavior change in another pull request, return it to that owner.
3. Run focused checks and the full repository check at the Stack top. Compare refs with
   `gh stack view --json`. Fix local boundary drift with non-interactive `gh stack rebase --no-trunk`.
4. Use `$push-pr-stack` for every rewritten existing branch with the remote heads seen before local changes.
   Never push them one at a time. For a standalone pull request, prefer fast-forward; guard any rewritten
   push with its old remote head.
5. Read every remote head back, report the new map, and release the turn. Reactivate affected upper owners
   at their new heads.
6. Read its published pull request again before closing feedback. If its head changed, return
   `input-changed`.

Only publication is serialized. Different owners may still investigate, test, and write on separate
threads. Use one writer per thread and do not run beside a process that can switch the shared GitHub account.

If a configured reviewer skips rewritten history, the owner may request another review only when its
current-head check is missing or neutral. Never duplicate a queued, running, or successful request. For Cubic:

```text
@cubic-dev-ai review this PR after the Stack rebase.
```

Read the request and later check back. Posting alone does not prove review ran.

## Threads

The owner that assessed a thread must finish it after any fix is published:

1. Recheck the pull request head and account.
2. Use `$resolve-pr-thread` with the thread ID, root comment ID, expected head, expected account, reply file,
   `+1`, and permission to resolve. Use `-1` only when the user chose it.
3. Read the reply, reaction, and resolution back. Do not blindly retry `partial`, `indeterminate`, or
   `input-changed`.
4. Keep an already-resolved thread resolved while adding any missing reply or reaction. Recheck old,
   resolved, and outdated findings at the current head.

The coordinator must not do this for an owner.

## Finish

An owner reports `clean` only when one stable head is:

- open, ready for review, linear, mergeable, and conflict-free;
- passing every current and expected CI and reviewer check, with none neutral, skipped, missing, pending,
  cancelled, timed out, or superseded-only;
- fully read for configured-bot feedback, with no reading or assessment gap;
- left with only invalid, already addressed, or informational findings;
- complete for every needed reply, reaction, and resolution;
- clean in GitHub's merge state; and
- free of human decisions, outside approvals, service gaps, and local work.

Return `ready-to-merge` only after every owner is clean and a final Stack snapshot matches their heads and
bottom-to-top order with no conflict. Send any mismatch back to its owner.

Otherwise keep the owner active or return one result: `dry-run`, `input-changed`, `indeterminate`,
`human-decision`, `blocked`, `tool-unavailable`, `timeout`, `unsupported-input`, or `provider-error`.
Never merge.
