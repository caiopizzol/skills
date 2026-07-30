# Deterministic tooling

Use `video-tools` from `PATH` when installed. From a skills checkout, run:

```sh
bun run --cwd <skills-checkout> video-tools prepare <video-path> [--artifacts-dir <artifacts-directory>]
```

Pass `--artifacts-dir` when the caller supplies one. Otherwise omit it. The tool creates an isolated
temporary directory, reports `{ directory, mode: "temporary" }` under `artifacts`, and retains the
derivatives for inspection. Report that directory so the caller can inspect or remove it.

The installed skill is normally a symlink into its checkout. Resolve that symlink rather than searching
unrelated directories.

The host path requires `ffmpeg` and `ffprobe`. A caller may instead provide an already-present,
digest-pinned container with `--container-image <name@sha256:digest>` when Docker is authorized. The
command never pulls or builds an image.

Container execution disables networking, uses a read-only root, drops capabilities, mounts only the
input read-only and the artifacts directory writable, and invokes tools without a shell. The result
records both the requested digest and resolved local image ID.

Use `--frame-count <count>` for even sampling, `--max-frames <count>` as its ceiling, and
`--timeout-ms <milliseconds>` for each tool call.

Read the JSON result. Exit `0` means every applicable preparation completed. Exit `2` preserves an
unavailable, unsupported, failed, timed-out, or changed-input result. Exit `1` means the arguments or
input path could not be used and emits no JSON.
