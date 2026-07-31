---
name: summarize-youtube
description: Summarize one public YouTube video from spoken and visual evidence while preserving coverage gaps. Use when the user wants its content or key points.
---

# Summarize a YouTube video

1. Invoke `$download-youtube-video`.
2. Pass its exact path and SHA-256 to `$read-video`.
3. Summarize only the evidence `$read-video` returns. Do not invoke its child skills directly.

Return a concise summary and content-only key points, followed by material coverage gaps. Put
timestamps, tooling, hashes, and lane status in coverage, not key points. Label a partial inspection as
partial. When no content was inspected, report that instead of inventing key points.
