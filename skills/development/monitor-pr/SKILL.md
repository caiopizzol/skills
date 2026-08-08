---
name: monitor-pr
description: Monitor one exact GitHub pull request or its managed Stack until ready to merge. Use after implementation is complete to fix and publish valid CI or configured-reviewer findings, reply and react to feedback, resolve review threads, and keep monitoring the current head. Never merge.
---

# Monitor a pull request to ready

Require one exact pull request URL plus the expected writer, configured reviewers, and expected checks
from the caller or repository configuration. Never guess authority.

Invocation authorizes marking the PR or Stack ready and performing the workflow's fixes, pushes, replies,
reactions, and resolutions. A requested dry run changes nothing.

Read [the workflow](references/workflow.md) before acting.

Never merge, queue, enable auto-merge, dismiss feedback, or bypass requirements. Before every mutation,
verify the expected actor and exact remote head; read the mutation back. Own a standalone PR directly;
delegate one persistent owner per PR only for a Stack, and serialize Stack publication.
