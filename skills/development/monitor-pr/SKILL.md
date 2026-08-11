---
name: monitor-pr
description: Monitor one exact GitHub pull request or managed Stack until ready to merge. Use after implementation to mark it ready, watch current-head checks and review feedback, fix valid problems, publish safely, and resolve threads. Never merge.
---

# Monitor a pull request

Require one exact `https://github.com/OWNER/REPOSITORY/pull/NUMBER` URL. Invocation allows marking the pull
request, or each open Stack member, ready for review. Get the expected writer and reviewer bot logins from
the user or repository instructions. Never infer them from the remote owner.

For a dry run or read-only request, return the work list and `dry-run`. Change nothing.

Read [the workflow](references/workflow.md) before acting.

## Coordinate

1. Collect the exact pull request or Stack and every current head SHA.
2. Give each pull request one persistent owner. Reuse that owner after later changes. Never split one pull
   request across comment-specific workers.
3. Keep the coordinator limited to Stack order, head SHAs, worker scheduling, publication turns, and final
   results. It must not inspect feedback, edit code, push, or close threads for a worker.
4. Each owner marks its pull request ready, reads it with `$read-github-pr`, verifies every claim, fixes and
   tests valid problems, publishes its changes, uses `$resolve-pr-thread`, and resumes monitoring.
5. Allow one Stack publication turn at a time. The owner applies its fix, rebases affected upper branches,
   tests the Stack, and uses `$push-pr-stack`.
6. Call the Stack ready only from clean owner reports tied to one unchanged final head map.

Keep every fix within the user's original goal. Address real problems without expanding scope.

## Stop

Use the exact terminal checks and outcomes in the workflow. Return `ready-to-merge` only when every scoped
pull request passes them. Never weaken a condition.

## Rules

- Never merge, queue, enable auto-merge, dismiss feedback, or bypass requirements.
- Never treat neutral, skipped, missing, old, or stale-head checks as success.
- Serialize Stack rebases and pushes. Different owners may investigate separate threads in parallel.
- Use one writer per thread.
- Pin one shared GitHub CLI configuration. Verify the expected account before every GitHub change and read
  the change back. An unexpected account change makes the result `indeterminate`.
- A lower Stack change invalidates affected upper reviews. Reactivate their existing owners at the new heads.
