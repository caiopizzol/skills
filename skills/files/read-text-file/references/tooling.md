# Tools

Use `text-tools` from `PATH` when installed. From this repository, run:

```sh
bun run --cwd <skills-checkout> text-tools inspect <exact-text-path>
```

An installed skill is usually a symlink to this repository. Resolve it instead of searching other folders.

Use `--max-characters <count>` for the user's limit. The 100,000-character default keeps exact ranges from
the start and end.

The command reads and hashes the file. It writes nothing and uses no network.

Read the JSON result, not only the exit code. Exit `0` means the full file decoded and parsed. Exit `2`
returns an undecodable, invalid, or partial result. Exit `1` means invalid arguments or path and writes no
JSON.
