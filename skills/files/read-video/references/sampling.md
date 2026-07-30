# Bounded sampling

## Why sampling is bounded

A frame is one instant. Extracting every frame of a six-second clip at 24 frames per second produces 144 images, and reading them all costs far more than the evidence is worth. A bound keeps the cost predictable, and reporting the bound keeps the reading honest about how little of the video was seen.

The caller owns the bound. When the caller supplies a maximum frame count, that value wins. When the caller supplies nothing, the bundled tools default to three frames and refuse to exceed twelve.

## How timestamps are chosen

Sampling is deterministic: the same duration and the same requested count always produce the same timestamps, so a second reading of the same file is comparable to the first.

For a requested count, the samples are spread evenly from the first instant to just inside the end. Three frames of a six-second video land at 0, 2.95, and 5.9 seconds, which covers the beginning, the middle, and the end. The last sample sits a fraction inside the end because seeking to the exact final instant is not reliable across containers.

Three bounds apply, and the plan records which one was binding:

- `requested`: the caller's count fit within the other two bounds.
- `max-frames`: the ceiling cut the requested count.
- `duration`: the video is too short to hold that many distinct instants. Samples closer together than one second describe the same moment, so a three-second video yields at most three frames however many are asked for.

A caller may supply explicit timestamps instead of a count. Those are sorted, deduplicated, and bounded by the maximum. A timestamp at or beyond the duration is rejected and reported, never clamped to the end: a clamped timestamp would claim a frame was sampled at a moment the caller did not ask about.

A duration of zero or less, or an explicit list with nothing inside the duration, is an `unsupported-input` outcome rather than an empty frame set.

## Why coverage is reported as intervals

A frame count is not coverage. Twelve frames of a two-hour recording and twelve frames of a six-second clip are the same number and wildly different evidence.

A percentage is worse, because it implies a share of content seen. Frames sample instants, not spans, so the share of duration a frame set observes is effectively zero no matter how many frames were taken. Anything that happened between two samples was not seen, and a percentage hides that.

Report instead:

- Every sampled timestamp, in seconds.
- Every interval no frame observed, as a start and an end in seconds.
- The total duration, so the omitted duration is arithmetic the caller can check.

Three frames of a six-second video leave the intervals 0 to 2.95, 2.95 to 5.9, and 5.9 to 6 unobserved. Say that, rather than that half the video was covered.

When the objective points at a specific moment, such as a transcript line or a described transition, sample that moment explicitly and say why it was chosen. A targeted sample is stronger evidence than an evenly spaced one, and the reader needs to know which kind it is looking at.

## Derivative manifest shape

Every derivative carries five fields:

- `path`: the derivative's location beneath the caller's artifacts directory.
- `bytes`: its byte count.
- `sha256`: the hash of its own bytes.
- `operation`: `extract-audio` or `extract-frames`.
- `parentSha256`: the SHA-256 of the original file it came from.

The parent hash is what makes a derivative traceable. Without it, an extracted frame is an image with no provable origin, so a record missing it is invalid and is not reported as evidence.

A frame record pairs its derivative with the timestamp it was sampled at, so the manifest and the coverage report describe the same set.

Discard partial output rather than recording it. A run that timed out or exited non-zero may have left a truncated file behind; hashing it would produce a manifest entry that looks complete and is not.
