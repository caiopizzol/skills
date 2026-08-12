---
name: download-youtube-video
description: Download one YouTube video the user can access as an exact local artifact. Use their signed-in browser session and return a concrete user action when access is unavailable.
---

# Download a YouTube video

1. Accept one exact YouTube video URL the user can access and an optional artifacts directory. Create an
   isolated temporary directory when none is supplied.
2. Use an existing downloader such as `yt-dlp` with the user's signed-in browser session. Follow
   [browser access](references/browser-access.md). Never install tools or bypass access controls.
3. Read only necessary metadata fields. Never emit full downloader metadata because it may contain
   signed URLs.
4. Prefer 720p or lower unless the objective needs more. Check duration and estimated size, and ask
   before a large transfer.
5. Download one playable video file, including audio when present, without overwriting anything. Hash
   the completed file.
6. Report the canonical video ID, downloader version, path, bytes, SHA-256, title, duration, and gaps.

Remove incomplete files. Preserve `retrieved`, `action_required`, `not_found`, `access_denied`,
`unsupported`, and `failed`. Report a missing downloader explicitly.
