---
name: setup-tests
description: Set up or simplify a repository's local testing foundation with its existing runner, deterministic tests, one root test command, and inclusion in the root check. Use when a single package or monorepo lacks a reliable automated test path.
---

# Set up tests

Establish one reliable test path without choosing architecture the repository does not need.

## Workflow

1. Inspect testable behavior, existing runners, configuration, scripts, and suites. Preserve the runner
   and use the framework or toolchain's integrated runner when available.
2. Add only required configuration and one non-watch root `test` command that runs every existing suite.
   Include test files in the repository's type-checking path.
3. When no suitable test exists, add one meaningful test of existing behavior. Never use a placeholder,
   live network, or external service; use local fixtures when inputs are needed.
4. Do not let an intended test target pass when it discovers zero tests. Report projects that still lack
   a testable behavior or test lane.
5. Include `test` in the root `check` command without removing formatting, linting, or type checking.
6. Run `test` and `check`. In an isolated copy, break the tested behavior and confirm the root `test`
   command fails.

Do not add coverage thresholds, browser or end-to-end testing, mocking libraries, or extra test layers
without a concrete need.
