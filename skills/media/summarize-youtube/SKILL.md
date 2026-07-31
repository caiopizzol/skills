---
name: summarize-youtube
description: Summarize one public YouTube video from its spoken and visual evidence with explicit coverage gaps. Use when the user wants the content or key points of one YouTube video rather than the downloaded file itself.
---

# Summarize a YouTube video

## Workflow

1. Invoke `$download-youtube-video` with the exact URL and a caller-owned artifacts directory. Stop if
   it does not return `retrieved`.
2. Invoke `$read-video` with the downloaded path, SHA-256, summary objective, artifacts directory, and
   a bounded frame sample.
3. Produce the summary only from evidence returned by `$read-video`. Keep spoken claims, visual
   observations, and inferences distinguishable when that affects confidence.

Do not invoke image or audio skills directly. `$read-video` owns those child capabilities.

## Required output

- A concise summary.
- The key points.
- A compact coverage note naming sampled visual evidence, audio coverage, and material unread
  intervals or lanes.

The summary may hide acquisition and inspection mechanics. It must not hide uncertainty. Label a
partial inspection as partial and explain what evidence is missing.

Preserve the child skills' artifact identities, side effects, capability provenance, and failure
states. Never turn a missing child, failed retrieval, or unread lane into a complete summary. Never
commit downloaded media or derivatives.
