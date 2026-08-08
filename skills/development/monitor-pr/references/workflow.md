# PR monitoring workflow

## Setup

1. Run `bun --no-env-file <skill-directory>/scripts/snapshot.ts <pr-url>` and record the exact head of
   every scoped PR in bottom-to-top order.
2. Give each PR one persistent owner. Spawn it with `fork_turns: "none"` and pass only its URL and head,
   expected actor, reviewers and checks, worktree and artifacts paths, shared GitHub CLI configuration,
   and this skill path. The owner reads repository instructions itself.
3. For a standalone PR, let its owner publish directly. For a Stack, keep the coordinator limited to the
   head map, publication order, and final result.

If the expected writer is unavailable, stop before mutation. Before every mutation, verify the actor and
remote head against the recorded lease; on drift, make no change. Read every mutation back.

## Owner loop

At one exact head, each owner:

1. Runs `snapshot.ts <pr-url> --pr-only` and `$read-github-pr`. Reads all configured-reviewer feedback,
   including resolved and outdated threads, and identifies checks by `{ workflow, name }`.
2. Reproduces concrete findings and failing current-head checks. Fixes valid problems in its detached
   worktree, runs focused validation, and creates concise conventional commits.
3. Publishes under the recorded lease, then closes feedback. If no code change is needed, closes feedback
   at the unchanged head.
4. Repeats after every head, lower-Stack, check, conflict, or reviewer change until clean.

Run a repository-wide local check only when repository instructions require it before push or a broad
Stack rebase warrants it; otherwise let current-head CI be authoritative. Keep verbose logs in artifacts,
not model context. Mark drafts ready after the mutation guard passes.

## Stack publication

Grant one bottom-to-top publication turn at a time. The owner holding it applies its fix, rebases affected
upper branches, runs the relevant checks, verifies `gh stack view --json`, and uses `$push-pr-stack` with
the recorded remote heads. Read back the new map and reactivate every affected upper owner; lower changes
invalidate upper assessments.

If rewritten history leaves Cubic absent or neutral, and no equivalent request or successful check exists,
post `@cubic-dev-ai review this PR after the Stack rebase.` once and read back the request and result.

## Feedback

- Inline thread: use `$resolve-pr-thread` to reply with the evidence, react `+1`, and resolve. Do this even
  when the bot already says `Addressed` or resolved the thread.
- Unique actionable issue comment or review summary: react `+1` and post one concise top-level reply.
- Duplicate or aggregate finding: close the canonical thread once and avoid duplicate replies.

The owner that assessed a finding closes it. Treat partial or changed-input mutation results as non-clean.

## Finish

Report `ready-to-merge` only when every PR is open, ready, linear, mergeable, conflict-free, and clean at
the final unchanged head; every expected current-head check succeeded; reviewer retrieval is complete;
required replies, reactions, and resolutions are verified; no decision or evidence gap remains; and no
owner is active. Neutral, skipped, missing, superseded-only, and stale-head checks are not success.

For a Stack, take one final snapshot and require the same bottom-to-top head map. Otherwise keep the
responsible owner active or return the supported non-ready reason. Never merge.
