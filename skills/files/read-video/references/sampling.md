# Choosing frames

A frame shows one instant. Take as many frames as the objective needs. There is no fixed limit.

## Choose times

Read the whole timestamped transcript first. Pick one time for each moment the objective needs to see:
slides, charts, screens, visible text, demonstrations, or visual changes. Skip moments where only the
presenter talks unless the presenter matters.

To study a short stretch closely, such as an opening hook or a transition, take frames close together, for
example every half second.

After viewing the frames, request more when something is missing or unclear. If a frame misses the
visual, try a nearby time in the same segment. Reuse the same artifacts directory and source SHA-256.

Without a usable transcript, sample evenly with `--frame-count`. It defaults to five and keeps frames at
least one second apart.

The tool sorts and deduplicates times. It rejects times after the last video frame instead of moving them,
and lists them in the result.

## Report coverage

Frames sample instants, not spans. Report every sampled time, every interval no frame observed, and the
full duration. Do not report a coverage percentage.

Record each frame's time, path, bytes, SHA-256, operation, and parent SHA-256. Discard partial output after
a timeout or failure.
