# Skills

Composable agent skills for inspecting files, improving developer experience, and setting up repositories.

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
setup-project
├── setup-vite-plus
├── setup-typescript
├── setup-tests
└── setup-gh-repo
    ├── create-gh-repo
    ├── config-gh-repo
    ├── setup-gh-checks
    ├── setup-cubic
    └── protect-gh-repo

summarize-youtube
├── download-youtube-video
└── read-video
    ├── read-image
    └── transcribe-audio
```

## Skill catalog

Start with a composite for an end-to-end outcome, or choose a focused skill for one capability.

### Codebase

| Skill                                                           | Type      | Purpose                                            |
| --------------------------------------------------------------- | --------- | -------------------------------------------------- |
| [`config-gh-repo`](skills/codebase/config-gh-repo/SKILL.md)     | Focused   | Configure merge and pull-request settings          |
| [`create-gh-repo`](skills/codebase/create-gh-repo/SKILL.md)     | Focused   | Create and connect a GitHub repository             |
| [`protect-gh-repo`](skills/codebase/protect-gh-repo/SKILL.md)   | Focused   | Protect merges using observed checks and reviewers |
| [`setup-changesets`](skills/codebase/setup-changesets/SKILL.md) | Focused   | Add reviewed releases from the default branch      |
| [`setup-cubic`](skills/codebase/setup-cubic/SKILL.md)           | Focused   | Configure focused Cubic code review                |
| [`setup-gh-checks`](skills/codebase/setup-gh-checks/SKILL.md)   | Focused   | Run an existing local check in GitHub Actions      |
| [`setup-gh-repo`](skills/codebase/setup-gh-repo/SKILL.md)       | Composite | Set up GitHub settings, checks, and protection     |
| [`setup-project`](skills/codebase/setup-project/SKILL.md)       | Composite | Create, assess, or complete a project's setup      |
| [`setup-tests`](skills/codebase/setup-tests/SKILL.md)           | Focused   | Establish one reliable local test path             |
| [`setup-typescript`](skills/codebase/setup-typescript/SKILL.md) | Focused   | Set up strict TypeScript configuration             |
| [`setup-vite-plus`](skills/codebase/setup-vite-plus/SKILL.md)   | Focused   | Set up the Vite+ toolchain                         |

### Context

| Skill                                                            | Type    | Purpose                             |
| ---------------------------------------------------------------- | ------- | ----------------------------------- |
| [`read-slack-thread`](skills/context/read-slack-thread/SKILL.md) | Focused | Read one exact Slack thread via MCP |

### DX

| Skill                                                           | Type    | Purpose                                          |
| --------------------------------------------------------------- | ------- | ------------------------------------------------ |
| [`improve-codebase-dx`](skills/dx/improve-codebase-dx/SKILL.md) | Focused | Find and reduce developer friction in a codebase |

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

| Skill                                                                    | Type      | Purpose                                           |
| ------------------------------------------------------------------------ | --------- | ------------------------------------------------- |
| [`download-youtube-video`](skills/media/download-youtube-video/SKILL.md) | Focused   | Download one public video as an exact local file  |
| [`summarize-youtube`](skills/media/summarize-youtube/SKILL.md)           | Composite | Summarize spoken and visual evidence from YouTube |

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
