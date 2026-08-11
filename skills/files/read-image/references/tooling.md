# Tools

Use `image-tools` from `PATH` when installed. From this repository, run:

```sh
bun run --cwd <skills-checkout> image-tools prepare <image-path> --artifacts-dir <artifacts-directory>
```

An installed skill is usually a symlink to this repository. Resolve it instead of searching other folders.

The local route needs `magick` and `identify`. When Docker is allowed, the user may provide an existing
container pinned by digest with `--container-image <name@sha256:digest>`. The command never pulls or builds
one.

The container has no network, a read-only root, no added capabilities, a read-only input mount, and one
writable artifacts mount. It runs tools without a shell and records the requested digest and local image ID.

Use `--max-frames <count>` for animation bounds and `--timeout-ms <milliseconds>` for each tool call.

Read the JSON result. Exit `0` means preparation finished. Exit `2` returns an unavailable, unsafe,
unsupported, failed, timed-out, or changed-input result. Exit `1` means invalid arguments or path and writes
no JSON.
