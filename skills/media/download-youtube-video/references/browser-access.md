# Signed-in browser access

Use `yt-dlp --cookies-from-browser <browser>` only after YouTube rejects the unauthenticated request.
This uses access the user already has. It does not bypass account permissions.

Use the browser the user named. If none was named and the browser is unclear, ask which browser they use
for YouTube. Never print, persist, or return cookies. Use the session only to download the video; do not
read the transcript from the browser.

Retry the same URL and destination once with the browser session. If YouTube still requests sign-in,
return `action_required` with this action:

> Sign in to YouTube in `<browser>`, confirm that `<video URL>` plays there, then tell me to retry.

If the authenticated account cannot access the video, return `access_denied`. Do not ask for a password or
cookie file. If browser-cookie access itself fails, preserve the diagnostic and ask for one specific action
that can resolve it instead of substituting another access method.
