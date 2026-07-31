---
name: download-youtube-video
description: Download one public YouTube video as an exact local artifact with provenance and explicit failures. Use when another capability needs local video bytes.
---

# Download a YouTube video

1. Accept one exact public video URL and an optional artifacts directory. Create an isolated temporary
   directory when none is supplied.
2. Use an existing downloader such as `yt-dlp`. Never install tools, use cookies, or bypass access
   controls.
3. Read only necessary metadata fields. Never emit full downloader metadata because it may contain
   signed URLs.
4. Prefer 720p or lower unless the objective needs more. Check duration and estimated size, and ask
   before a large transfer.
5. Download one playable video file, including audio when present, without overwriting anything. Hash
   the completed file.
6. Report the canonical video ID, downloader version, path, bytes, SHA-256, title, duration, and gaps.

Remove incomplete files. Preserve `retrieved`, `not_found`, `access_denied`, `unsupported`, and
`failed`. Report a missing downloader explicitly.
