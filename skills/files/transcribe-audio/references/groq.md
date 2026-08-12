# Groq Whisper

Use the bundled runner only after the user authorizes this exact audio to be uploaded to Groq:

```sh
bun --no-env-file <skill-directory>/scripts/transcribe-groq.ts <audio-path> \
  --expected-sha256 <sha256> --artifacts-dir <directory> --allow-hosted groq \
  [--language <iso-639-1-code>]
```

The runner reads `GROQ_API_KEY` from the existing environment and uses
`whisper-large-v3-turbo` with segment timestamps. It refuses unsupported formats and files above Groq's
25 MB upload limit. Do not split, compress, or truncate the audio without a separate user-approved bound.

Read the JSON result. Exit `0` means the timestamped transcript was written. Exit `2` preserves a named
capability, authorization, input, provider, or timeout failure. Exit `1` means the arguments are invalid.
