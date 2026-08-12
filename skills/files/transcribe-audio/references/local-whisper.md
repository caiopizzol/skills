# Local Whisper

Require `whisper-cli` and an existing GGML `large-v3-turbo` or `large-v3` model. Prefer Turbo for video.

Run:

```sh
bun --no-env-file <skill-directory>/scripts/transcribe-whisper.ts <audio-path> \
  --expected-sha256 <sha256> --artifacts-dir <directory> \
  [--model <ggml-model-path>] [--language <code>] [--timeout-ms <milliseconds>]
```

Use `WHISPER_MODEL_PATH` when configured. Otherwise, on macOS, check these existing files in order:

1. `$HOME/Library/Caches/whisper.cpp/ggml-large-v3-turbo.bin`
2. `$HOME/Library/Caches/whisper.cpp/ggml-large-v3.bin`

Pass the first file found with `--model`. If neither exists, ask the user for the local model path. Never
download a model.

Exit `0` writes a timestamped transcript. Exit `2` returns a named capability or transcription failure.
Exit `1` means invalid arguments.
