# Skills

Reusable agent skills for inspecting files and setting up repositories.

## Skill catalog

| Skill                                                           | Purpose                                            |
| --------------------------------------------------------------- | -------------------------------------------------- |
| [`create-gh-repo`](skills/codebase/create-gh-repo/SKILL.md)     | Create and connect a GitHub repository             |
| [`protect-gh-repo`](skills/codebase/protect-gh-repo/SKILL.md)   | Protect merges using observed checks and reviewers |
| [`read-image`](skills/files/read-image/SKILL.md)                | Inspect raster images, animations, and safe SVGs   |
| [`read-text-file`](skills/files/read-text-file/SKILL.md)        | Read bounded text and structured-data files        |
| [`read-video`](skills/files/read-video/SKILL.md)                | Inspect a video's visual and audio lanes           |
| [`transcribe-audio`](skills/files/transcribe-audio/SKILL.md)    | Transcribe audio with explicit temporal coverage   |
| [`setup-cubic`](skills/codebase/setup-cubic/SKILL.md)           | Configure focused Cubic code review                |
| [`setup-gh-checks`](skills/codebase/setup-gh-checks/SKILL.md)   | Run an existing local check in GitHub Actions      |
| [`setup-gh-repo`](skills/codebase/setup-gh-repo/SKILL.md)       | Set up GitHub checks, review, and merge protection |
| [`setup-typescript`](skills/codebase/setup-typescript/SKILL.md) | Set up strict TypeScript configuration             |
| [`setup-vite-plus`](skills/codebase/setup-vite-plus/SKILL.md)   | Set up the Vite+ toolchain                         |

## Install

Requires [Bun](https://bun.sh/).

```sh
git clone https://github.com/caiopizzol/skills.git
cd skills
bun install --production
bun run install:skills -- ~/.agents/skills read-video
```

Use `~/.agents/skills` for Codex or `~/.claude/skills` for Claude Code. The installer adds required
child skills automatically, so installing `read-video` also installs `read-image` and
`transcribe-audio`. Omit the skill name to install the full catalog.

Installation uses symlinks and is supported on macOS and Linux. Existing destinations are never
overwritten.

## Tooling

Image and video inspection use ImageMagick and FFmpeg when available. Missing tools are reported, not
installed or downloaded. Audio transcription comes from the agent runtime and may use a hosted service.

## Development

```sh
bun install
bun run check
```

This validates the skill catalog, typechecks the workspace, and runs fixture-only tests without network
access.

Committed fixtures use generated shapes, text tokens, and audio rather than customer or user data. They
are covered by this repository's MIT license.

## Licensing

Licensed under the [MIT License](LICENSE).
