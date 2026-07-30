# Deterministic tooling

Use `image-tools` from `PATH` when installed. From a skills checkout, run:

```sh
bun run --cwd <skills-checkout> image-tools prepare <image-path> --artifacts-dir <artifacts-directory>
```

The installed skill is normally a symlink into its checkout. Resolve that symlink rather than searching
unrelated directories.

The host path requires `magick` and `identify`. A caller may instead provide an already-present,
digest-pinned container with `--container-image <name@sha256:digest>` when Docker is authorized. The
command never pulls or builds an image.

Container execution disables networking, uses a read-only root, drops capabilities, mounts only the
input read-only and the artifacts directory writable, and invokes tools without a shell. The result
records both the requested digest and resolved local image ID.

Use `--max-frames <count>` for animation bounds and `--timeout-ms <milliseconds>` for each tool call.

Read the JSON result. Exit `0` means every applicable preparation completed. Exit `2` preserves an
unavailable, unsafe, unsupported, failed, timed-out, or changed-input result. Exit `1` means the arguments
or input path could not be used and emits no JSON.
