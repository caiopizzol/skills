# Frame sampling

A frame shows one instant. Use the user's limit. Without one, sample three frames and never exceed twelve.

## Choose times

The same duration and count must produce the same times. Spread frames from the start to just before the
end. For a six-second video, three frames fall at 0, 2.95, and 5.9 seconds. Do not seek to the exact end.

Record what limited the count:

- `requested`: the user's count fit.
- `max-frames`: the maximum reduced it.
- `duration`: the video was too short for that many distinct seconds.

When the user gives exact times, sort them, remove duplicates, and apply the maximum. Reject times at or
after the end; do not move them. Return `unsupported-input` for a duration of zero or less, or when no given
time falls inside the video.

When the objective names a moment, sample it and explain why. Mark each frame as targeted or evenly spaced.

## Report coverage

Do not use a frame count or percentage as coverage. Report:

- every sampled time in seconds;
- every unseen interval with start and end times; and
- the full duration.

For the six-second example, the unseen intervals are 0 to 2.95, 2.95 to 5.9, and 5.9 to 6.

## Extracted file records

Record `path`, `bytes`, `sha256`, `operation` (`extract-audio` or `extract-frames`), and `parentSha256`.
Without the original hash, the file is not evidence. Add the sampled time for frames. Discard partial files
after a timeout or failed command.
