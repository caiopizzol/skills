# Deterministic tooling

Use `text-tools` from `PATH` when installed. From a skills source checkout, run the same command with:

```sh
bun run --cwd <skills-checkout> text-tools inspect <exact-text-path>
```

The installed skill is normally a symlink into its checkout. Resolve that symlink when the checkout is otherwise unknown. Do not search unrelated directories for a probable copy.

Use `--max-characters <count>` when the caller supplied a bound. The default is 100,000 characters, retained as an exact head and tail range.

The command reads the file, hashes its bytes, and writes nothing. It uses no network and creates no derivatives.

Read the JSON result rather than inferring success from the exit code. Exit `0` means the file decoded, parsed, and was retained in full. Exit `2` preserves an undecodable, structurally invalid, or bounded-partial outcome rather than flattening it into absence. Exit `1` means the arguments or the input path could not be used and prints no JSON.
