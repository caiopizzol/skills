# Tools

Use `video-tools` from `PATH` when installed. From this repository, run:

```sh
bun run --cwd <skills-checkout> video-tools prepare <video-path> [--artifacts-dir <artifacts-directory>]
```

Pass `--artifacts-dir` when the user supplies one. Otherwise the tool creates a temporary directory,
reports `{ directory, mode: "temporary" }` under `artifacts`, and keeps the extracted files. Report its path.

An installed skill is usually a symlink to this repository. Resolve it instead of searching other folders.

The local route needs `ffmpeg` and `ffprobe`. When Docker is allowed, the user may provide an existing
container pinned by digest with `--container-image <name@sha256:digest>`. The command never pulls or builds
one.

The container has no network, a read-only root, no added capabilities, a read-only input mount, and one
writable artifacts mount. It runs tools without a shell and records the requested digest and local image ID.

Use `--frame-count <count>` for even sampling, `--max-frames <count>` as its ceiling, and
`--timeout-ms <milliseconds>` for each tool call.

Read the JSON result. Exit `0` means preparation finished. Exit `2` returns an unavailable, unsupported,
failed, timed-out, or changed-input result. Exit `1` means invalid arguments or path and writes no JSON.
