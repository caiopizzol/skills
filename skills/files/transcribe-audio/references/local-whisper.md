# Local Whisper

Require `whisper-cli` and an existing GGML `large-v3-turbo` or `large-v3` model. Prefer Turbo for video.

Run:

```sh
bun --no-env-file <skill-directory>/scripts/transcribe-whisper.ts <audio-path> \
  --expected-sha256 <sha256> --artifacts-dir <directory> \
  [--model <ggml-model-path>] [--language <code>] [--timeout-ms <milliseconds>]
```

Use `WHISPER_MODEL_PATH` instead of `--model` when already configured. Exit `0` writes a timestamped
transcript. Exit `2` returns a named capability or transcription failure. Exit `1` means invalid arguments.
