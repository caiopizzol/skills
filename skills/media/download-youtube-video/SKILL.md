---
name: download-youtube-video
description: Download one public YouTube video as an exact local file, with its source details and clear failure results. Use when another skill needs the video file.
---

# Download a YouTube video

1. Accept one exact public video URL and an optional artifacts directory. If none is given, create an
   isolated temporary directory.
2. Use an existing downloader such as `yt-dlp`. Never install tools, use cookies, or bypass access rules.
3. Read only needed metadata. Full downloader metadata may contain signed URLs, so never return it.
4. Prefer 720p or lower unless the objective needs more. Check duration and estimated size. Ask before a
   large download.
5. Download one playable video, with audio when available, without overwriting files. Hash it after the
   download finishes.
6. Report the video ID, downloader version, path, bytes, SHA-256, title, duration, and anything missing.

Remove incomplete files. Keep `retrieved`, `not_found`, `access_denied`, `unsupported`, and `failed`
separate. Report a missing downloader.
