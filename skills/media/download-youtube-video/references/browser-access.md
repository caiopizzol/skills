# Signed-in browser access

Use `yt-dlp --cookies-from-browser <browser>` to download with the user's YouTube session.

Use the browser the user named. Otherwise return `action_required`:

> Tell me which browser is signed in to YouTube and can play `<video URL>`.

Never print, persist, or return cookies.

If YouTube requests sign-in, return `action_required`:

> Sign in to YouTube in `<browser>`, confirm that `<video URL>` plays there, then tell me to retry.

If the authenticated account cannot access the video, return `access_denied`. Do not ask for a password or
cookie file. If cookie extraction fails, describe the failure without including signed URLs, cookies, or
other secrets. Ask the user to run the same command and provide the downloaded file path.
