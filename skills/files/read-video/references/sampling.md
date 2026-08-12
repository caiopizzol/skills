# Bounded sampling

A frame shows one instant. Use the caller's bound, default to three, and never exceed twelve.

## Choose timestamps

Use transcript timestamps for demonstrations, slides, charts, interfaces, visible text, or visual changes.
Skip presenter-only frames unless the presenter matters.

Sample inside the relevant segment. If the frame misses the visual, replace it with a nearby time from the
same segment without increasing the bound.

Without usable timestamps, spread three frames from the start to just before the end. For a six-second
video, use 0, 2.95, and 5.9 seconds.

Sort and deduplicate explicit timestamps. Reject times outside the duration; never clamp them. A
non-positive duration or no valid time is `unsupported-input`.

Record whether each frame was transcript-targeted or evenly spaced. Record what limited the count:

- `requested`: the caller's count fit.
- `max-frames`: the ceiling reduced it.
- `duration`: the video was too short for that many distinct instants.

## Report coverage

Frames sample instants, not spans. Report:

- every sampled timestamp in seconds;
- every interval no frame observed; and
- the full duration.

Do not report a coverage percentage. Record each frame's time, path, bytes, SHA-256, operation, and parent
SHA-256. Discard partial output after a timeout or failure.
