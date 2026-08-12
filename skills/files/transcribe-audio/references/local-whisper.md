# Local Whisper

Require `whisper-cli` and an existing GGML `large-v3-turbo` or `large-v3` model. Prefer Turbo for ordinary
video transcription. Do not install tools or download models during the task.

Run:

```sh
bun --no-env-file <skill-directory>/scripts/transcribe-whisper.ts <audio-path> \
  --expected-sha256 <sha256> --artifacts-dir <directory> \
  [--model <ggml-model-path>] [--language <code>] [--timeout-ms <milliseconds>]
```

`WHISPER_MODEL_PATH` may supply the model path. Read the JSON result. Exit `0` writes a timestamped
transcript. Exit `2` preserves a named capability, input, model, transcription, or timeout failure. Exit
`1` means the arguments are invalid.
