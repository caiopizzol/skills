# Bounded sampling

A frame shows one instant. Use the caller's bound. Without one, inspect at most three relevant frames.
Never exceed twelve.

## Choose timestamps

Use a timestamped transcript to find moments where the image affects the objective: demonstrations,
slides, charts, interfaces, visible text, or meaningful visual changes. Do not spend the bound on
presenter-only frames unless the presenter is relevant.

Sample inside the relevant transcript segment. Prefer the midpoint between its timestamp and the next
segment's timestamp. If that frame misses the moment, use one nearby time from the same segment without
increasing the bound.

When no usable timestamps exist, spread three frames from the start to just before the end. For a
six-second video, use 0, 2.95, and 5.9 seconds. Do not seek to the exact end.

Explicit timestamps are sorted, deduplicated, and bounded by the maximum. Reject and report timestamps
outside the duration; never clamp them. A non-positive duration or a list with no valid time is
`unsupported-input`.

Record whether each frame was transcript-targeted or evenly spaced and what limited the count:

- `requested`: the caller's count fit.
- `max-frames`: the ceiling reduced it.
- `duration`: the video was too short for that many distinct instants.

## Report coverage

Frames sample instants, not spans. Report:

- every sampled timestamp in seconds;
- every interval no frame observed; and
- the full duration.

Do not report a coverage percentage.

## Record derivatives

Record `path`, `bytes`, `sha256`, `operation`, and `parentSha256`. Add the sampled time for frames. A
derivative without the original hash is not evidence. Discard partial output after a timeout or failed
command.
