# Skills

Agent skills for reading files and setting up repositories.

[![Release](https://img.shields.io/github/v/release/caiopizzol/skills)](https://github.com/caiopizzol/skills/releases/latest)
[![Checks](https://github.com/caiopizzol/skills/actions/workflows/check.yml/badge.svg)](https://github.com/caiopizzol/skills/actions/workflows/check.yml)
[![License](https://img.shields.io/github/license/caiopizzol/skills)](LICENSE)

## How they work

A focused skill does one job. A combined skill calls other skills with `$name`. Folders only organize the
source; installation adds required child skills automatically.

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

### Codebase

| Skill                                                           | Type     | Purpose                                            |
| --------------------------------------------------------------- | -------- | -------------------------------------------------- |
| [`config-gh-repo`](skills/codebase/config-gh-repo/SKILL.md)     | Focused  | Configure merge and pull request settings          |
| [`create-gh-repo`](skills/codebase/create-gh-repo/SKILL.md)     | Focused  | Create and connect a GitHub repository             |
| [`protect-gh-repo`](skills/codebase/protect-gh-repo/SKILL.md)   | Focused  | Protect merges using observed checks and reviewers |
| [`setup-changesets`](skills/codebase/setup-changesets/SKILL.md) | Focused  | Add reviewed package releases                      |
| [`setup-cubic`](skills/codebase/setup-cubic/SKILL.md)           | Focused  | Configure Cubic code review                        |
| [`setup-gh-checks`](skills/codebase/setup-gh-checks/SKILL.md)   | Focused  | Run a local check in GitHub Actions                |
| [`setup-gh-repo`](skills/codebase/setup-gh-repo/SKILL.md)       | Combined | Set up GitHub settings, checks, and protection     |
| [`setup-project`](skills/codebase/setup-project/SKILL.md)       | Combined | Create or complete a project setup                 |
| [`setup-tests`](skills/codebase/setup-tests/SKILL.md)           | Focused  | Add one reliable local test path                   |
| [`setup-typescript`](skills/codebase/setup-typescript/SKILL.md) | Focused  | Set up strict TypeScript                           |
| [`setup-vite-plus`](skills/codebase/setup-vite-plus/SKILL.md)   | Focused  | Set up Vite+                                       |

### Context

| Skill                                                                            | Purpose                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| [`read-discord-conversation`](skills/context/read-discord-conversation/SKILL.md) | Read one Discord conversation            |
| [`read-github-issue`](skills/context/read-github-issue/SKILL.md)                 | Read one GitHub issue                    |
| [`read-github-pr`](skills/context/read-github-pr/SKILL.md)                       | Read one pull request and its reviews    |
| [`read-github-resource`](skills/context/read-github-resource/SKILL.md)           | Fetch GitHub issue or pull request data  |
| [`read-linear-issue`](skills/context/read-linear-issue/SKILL.md)                 | Read one Linear issue and linked context |
| [`read-slack-thread`](skills/context/read-slack-thread/SKILL.md)                 | Read one Slack thread and selected files |

### Development

| Skill                                                                | Type     | Purpose                              |
| -------------------------------------------------------------------- | -------- | ------------------------------------ |
| [`monitor-pr`](skills/development/monitor-pr/SKILL.md)               | Combined | Monitor and fix a PR or Stack        |
| [`push-pr-stack`](skills/development/push-pr-stack/SKILL.md)         | Focused  | Push rewritten Stack branches safely |
| [`resolve-pr-thread`](skills/development/resolve-pr-thread/SKILL.md) | Focused  | Close one checked PR review thread   |

### Files

| Skill                                                        | Type     | Purpose                                   |
| ------------------------------------------------------------ | -------- | ----------------------------------------- |
| [`read-image`](skills/files/read-image/SKILL.md)             | Focused  | Inspect images, animations, and safe SVGs |
| [`read-text-file`](skills/files/read-text-file/SKILL.md)     | Focused  | Read text and data files                  |
| [`read-video`](skills/files/read-video/SKILL.md)             | Combined | Inspect video frames and audio            |
| [`transcribe-audio`](skills/files/transcribe-audio/SKILL.md) | Focused  | Transcribe audio with time coverage       |

### Media

| Skill                                                                    | Type     | Purpose                             |
| ------------------------------------------------------------------------ | -------- | ----------------------------------- |
| [`download-youtube-video`](skills/media/download-youtube-video/SKILL.md) | Focused  | Download one public YouTube video   |
| [`summarize-youtube`](skills/media/summarize-youtube/SKILL.md)           | Combined | Summarize a YouTube video's content |

## Install

Requires [Bun](https://bun.sh/).

```sh
git clone https://github.com/caiopizzol/skills.git
cd skills
bun install --production
bun run install:skills -- ~/.agents/skills read-video
```

Use `~/.agents/skills` for Codex or `~/.claude/skills` for Claude Code. Omit the skill name to install all
skills. The installer adds required child skills and never overwrites an existing destination.

Installation uses symlinks and supports macOS and Linux.

## Tools

Image and video skills use installed ImageMagick and FFmpeg tools. They report missing tools instead of
installing them. Audio transcription comes from the agent runtime and may use a hosted service.

## Development

```sh
bun install
bun run check
```

The check validates the catalog, checks TypeScript, and runs local fixture tests without network access.
Fixtures use generated content, not customer or user data.

## License

[MIT](LICENSE)
