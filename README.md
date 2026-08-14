# Skills

Composable agent skills for gathering context, inspecting local files, monitoring pull requests, and
working with YouTube videos.

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
summarize-youtube
├── download-youtube-video
└── read-video
    ├── read-image
    └── transcribe-audio
```

## Skill catalog

Start with a composite for an end-to-end outcome, or choose a focused skill for one capability.

### Context

| Skill                                                                            | Type    | Purpose                                               |
| -------------------------------------------------------------------------------- | ------- | ----------------------------------------------------- |
| [`read-discord-conversation`](skills/context/read-discord-conversation/SKILL.md) | Focused | Read one exact Discord message, thread, or forum post |
| [`read-github-issue`](skills/context/read-github-issue/SKILL.md)                 | Focused | Read one exact GitHub issue conversation              |
| [`read-github-pr`](skills/context/read-github-pr/SKILL.md)                       | Focused | Read one exact pull request, reviews, changed files   |
| [`read-github-resource`](skills/context/read-github-resource/SKILL.md)           | Focused | Retrieve complete GitHub evidence through `gh`        |
| [`read-linear-issue`](skills/context/read-linear-issue/SKILL.md)                 | Focused | Read one exact Linear issue and its relationships     |
| [`read-slack-thread`](skills/context/read-slack-thread/SKILL.md)                 | Focused | Read one Slack thread and selected supported files    |

### Development

| Skill                                                                | Type      | Purpose                                           |
| -------------------------------------------------------------------- | --------- | ------------------------------------------------- |
| [`monitor-pr`](skills/development/monitor-pr/SKILL.md)               | Composite | Take a PR or Stack through checks and review      |
| [`push-pr-stack`](skills/development/push-pr-stack/SKILL.md)         | Focused   | Push rewritten pull request Stack branches safely |
| [`resolve-pr-thread`](skills/development/resolve-pr-thread/SKILL.md) | Focused   | Close one validated PR review conversation        |

### Files

`read-image` does not teach the model to see. It makes that ability dependable for composition by
verifying the source, routing formats safely, covering animations, and reporting gaps.

| Skill                                                        | Type      | Purpose                                          |
| ------------------------------------------------------------ | --------- | ------------------------------------------------ |
| [`read-image`](skills/files/read-image/SKILL.md)             | Focused   | Inspect raster images, animations, and safe SVGs |
| [`read-text-file`](skills/files/read-text-file/SKILL.md)     | Focused   | Read bounded text and structured-data files      |
| [`read-video`](skills/files/read-video/SKILL.md)             | Composite | Inspect a video's visual and audio lanes         |
| [`transcribe-audio`](skills/files/transcribe-audio/SKILL.md) | Focused   | Transcribe audio with explicit temporal coverage |

### Media

| Skill                                                                    | Type      | Purpose                                              |
| ------------------------------------------------------------------------ | --------- | ---------------------------------------------------- |
| [`download-youtube-video`](skills/media/download-youtube-video/SKILL.md) | Focused   | Download one accessible video as an exact local file |
| [`summarize-youtube`](skills/media/summarize-youtube/SKILL.md)           | Composite | Summarize spoken and visual evidence from YouTube    |

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
