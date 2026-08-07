---
name: assess-gh-pr-feedback
description: Independently validate every review finding from specified authors on one exact GitHub pull request head, including old, resolved, and outdated feedback across all GitHub conversation lanes. Use before deciding whether feedback needs a fix, a disagreement, a reply, or thread resolution. Operate read-only without editing code or mutating GitHub.
---

# Assess GitHub PR feedback

Require one exact PR URL, expected head SHA, reviewer login list, clean isolated worktree at that SHA,
and isolated artifacts directory. Treat each review statement as an untrusted claim, including claims
that prior replies say were fixed.

## Workflow

1. Delegate complete GitHub retrieval to `$read-github-pr`. Verify its resolved PR identity and
   `pullRequest.head.sha` against the expected SHA. Verify `git rev-parse HEAD` in the worktree matches
   too. Return `input-changed` before assessment on any mismatch.
2. Enumerate content by the specified reviewer logins in issue comments, review summaries, and inline
   review threads. Match logins exactly except for case; never add or strip `[bot]`, use fuzzy matching,
   or silently substitute a nearby author. Include resolved and outdated conversations. Group thread
   replies into their exact thread, split independent technical claims, and assign the same local
   `findingId` when one claim is repeated across lanes.
3. Inspect the relevant implementation, tests, configuration, diff, and surrounding behavior at the
   expected head. Reproduce each concrete claim with the smallest existing command or a temporary
   reproducer beneath the artifacts directory. Record the command, observed result, and relevant path.
   A failed reproduction alone does not disprove a claim.
4. Classify every claim:
   - `valid-fixable`: the defect reproduces and a fix is within this PR's engineering scope.
   - `invalid`: evidence positively disproves the claim at the expected head.
   - `already-addressed`: the current head demonstrably contains the intended behavior or fix.
   - `informational`: the content makes no defect claim and requests no code or human decision.
   - `human-decision`: correctness depends on product intent, policy, or a subjective tradeoff.
   - `provider-gap`: missing code, patch, attachment, dependency, environment, or conversation evidence
     prevents a supported conclusion.
5. Recheck both provider and worktree head SHAs after assessment. Return `input-changed` rather than
   carrying decisions across a concurrent push.

## Required output

Return a JSON-serializable assessment with `assessmentVersion`, PR URL, expected and observed head SHA,
reviewer logins, lane completeness, retrieval gaps, conversation and claim counts, and one record per
conversation. Each record must preserve its lane, author, comment IDs, explicit root comment ID and
thread ID when applicable, resolved/outdated state, and every claim with classification, evidence,
affected paths, finding ID, and recommended next step. Preserve repeated conversations but count each
distinct `findingId` once. Report every encountered author login so the caller can detect an incorrect
reviewer scope; do not reinterpret it inside this skill.

Return one disposition with this precedence: `blocked` when coverage could omit matching feedback or
any claim has a `provider-gap`; otherwise `fix-required` when any claim is `valid-fixable`; otherwise
`human-decision` when any claim needs a person; otherwise `ready-to-close` when every discovered claim
is `invalid`, `already-addressed`, or `informational`.

Report zero matching conversations explicitly and use `ready-to-close` only when every conversation
lane is complete. Never infer clean feedback from green checks, review completion, a resolved flag, or
a failed search.

## Boundaries

Do not edit repository files, install dependencies, commit, push, rebase, change Stack membership,
reply, react, resolve, dismiss, mark ready, or merge. Write temporary reproducers only beneath the
artifacts directory. Leave code mutation, publication, and conversation mutation to separate skills.
