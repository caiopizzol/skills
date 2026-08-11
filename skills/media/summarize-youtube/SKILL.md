---
name: summarize-youtube
description: Summarize one public YouTube video from its audio and frames, while clearly stating what was not inspected.
---

# Summarize a YouTube video

1. Use `$download-youtube-video`. Stop unless it returns `retrieved`.
2. Pass its exact path and SHA-256 to `$read-video`.
3. Summarize only the evidence `$read-video` returns. Do not invoke its child skills directly.

Return a short summary and content-only key points, followed by important coverage gaps. Put timestamps,
tools, hashes, and frame or audio status under coverage, not key points. Label a partial reading as partial.
If no content was inspected, say so instead of inventing key points.
