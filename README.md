# Skills

Composable agent skills for working on codebases: taking pull requests to ready, reading GitHub
evidence, and inspecting the files it contains.

[![Release](https://img.shields.io/github/v/release/caiopizzol/skills)](https://github.com/caiopizzol/skills/releases/latest)
[![Checks](https://github.com/caiopizzol/skills/actions/workflows/check.yml/badge.svg)](https://github.com/caiopizzol/skills/actions/workflows/check.yml)
[![License](https://img.shields.io/github/license/caiopizzol/skills)](LICENSE)

## How skills compose

A skill is one callable capability. It can invoke another skill with a `$name` reference, and that
child can invoke children of its own. Composite skills coordinate several capabilities; focused skills
do one job.

This is closer to functions calling functions than a fixed level hierarchy. Categories organize the
source tree only. Installing a composite resolves its full dependency graph automatically.

```text
monitor-pr
├── push-pr-stack
├── resolve-pr-thread
└── read-github-pr
    ├── read-github-issue
    ├── read-github-resource
    ├── read-image
    ├── read-text-file
    ├── transcribe-audio
    └── read-video
        ├── read-image
        └── transcribe-audio
```

## Skill catalog

Start with a composite for an end-to-end outcome, or choose a focused skill for one capability.

### Development

| Skill                                                                      | Type      | Purpose                                             |
| -------------------------------------------------------------------------- | --------- | --------------------------------------------------- |
| [`monitor-pr`](skills/development/monitor-pr/SKILL.md)                     | Composite | Take a PR or Stack through checks and review        |
| [`push-pr-stack`](skills/development/push-pr-stack/SKILL.md)               | Focused   | Push rewritten pull request Stack branches safely   |
| [`read-github-issue`](skills/development/read-github-issue/SKILL.md)       | Focused   | Read one exact GitHub issue conversation            |
| [`read-github-pr`](skills/development/read-github-pr/SKILL.md)             | Focused   | Read one exact pull request, reviews, changed files |
| [`read-github-resource`](skills/development/read-github-resource/SKILL.md) | Focused   | Retrieve complete GitHub evidence through `gh`      |
| [`resolve-pr-thread`](skills/development/resolve-pr-thread/SKILL.md)       | Focused   | Close one validated PR review conversation          |

### Files

`read-image` does not teach the model to see. It makes that ability dependable for composition by
verifying the source, routing formats safely, covering animations, and reporting gaps.

| Skill                                                        | Type      | Purpose                                          |
| ------------------------------------------------------------ | --------- | ------------------------------------------------ |
| [`read-image`](skills/files/read-image/SKILL.md)             | Focused   | Inspect raster images, animations, and safe SVGs |
| [`read-text-file`](skills/files/read-text-file/SKILL.md)     | Focused   | Read bounded text and structured-data files      |
| [`read-video`](skills/files/read-video/SKILL.md)             | Composite | Inspect a video's visual and audio lanes         |
| [`transcribe-audio`](skills/files/transcribe-audio/SKILL.md) | Focused   | Transcribe audio with explicit temporal coverage |

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
installed or downloaded. Audio transcription uses local Whisper and sends nothing outside the runtime.

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
