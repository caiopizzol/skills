# Bounded sampling

A frame shows one instant. Use the caller's bound, default to five, and never exceed twelve.

## Choose timestamps

Review the complete timestamped transcript. When it identifies enough distinct demonstrations, slides,
charts, interfaces, visible text, or visual changes for the applied bound, choose one moment from each.
Spread the choices across the recording and its main topics. Skip presenter-only moments unless the
presenter matters.

Sample inside the relevant segment. If the frame misses the visual, replace it with a nearby time from the
same segment without increasing the bound.

When the transcript is unavailable, untimed, or does not identify enough distinct visual moments, spread
the bounded number of frames evenly from the start to just before the end. With the default five frames,
use 0, 1.475, 2.95, 4.425, and 5.9 seconds for a six-second video.

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
