# Deterministic tooling

Use `video-tools` from `PATH` when installed. From a skills checkout, replace `video-tools` below with
`bun run --cwd <skills-checkout> video-tools`.

Extract audio first:

```sh
video-tools prepare <video-path> --only audio [--artifacts-dir <directory>]
```

Then reuse the reported artifacts directory to extract transcript-selected frames:

```sh
video-tools prepare <video-path> --artifacts-dir <directory> --only frames \
  --frame-time <seconds> [--frame-time <seconds>...]
```

Use `--frame-count <count>` instead of `--frame-time` only when no usable timestamps exist. Use
`--max-frames <count>` as the ceiling and `--timeout-ms <milliseconds>` for each tool call. Do not combine
`--frame-count` with `--frame-time`.

The host path requires `ffmpeg` and `ffprobe`. A caller may instead provide an already-present,
digest-pinned container with `--container-image <name@sha256:digest>` when Docker is authorized. The
command never pulls or builds an image.

Container execution disables networking, uses a read-only root, drops capabilities, mounts only the
input read-only and the artifacts directory writable, and invokes tools without a shell. The result
records both the requested digest and resolved local image ID.

Read the JSON result. Exit `0` means every requested preparation completed. Exit `2` preserves an
unavailable, unsupported, failed, timed-out, or changed-input result. Exit `1` means the arguments or
input path could not be used and emits no JSON.
