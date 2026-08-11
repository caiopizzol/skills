---
name: setup-tests
description: Set up or check local tests using the repository's existing test runner, one root test command, and the root check.
---

# Set up tests

Create one reliable test path without adding layers the repository does not need.

For a check-only request, report `ready`, `gap`, `not-applicable`, or `unverified` with evidence. Do not
change anything.

## Steps

1. Check testable behavior, current runners, configuration, scripts, and test suites. Keep the current
   runner and prefer one built into the framework or toolchain.
2. Add only needed configuration and one non-watch root `test` command that runs every suite. Include test
   files in type checking.
3. If no useful test exists, add one test of current behavior. Do not use placeholders, live networks, or
   outside services. Use local fixtures when needed.
4. A test command must not pass after finding zero tests. Report projects that still have nothing useful
   to test.
5. Add `test` to the root `check` command without removing formatting, linting, or type checking.
6. Run `test` and `check`. In an isolated copy, break the tested behavior and confirm `test` fails.

Do not add coverage limits, browser or end-to-end tests, mocking libraries, or extra test layers without
a clear need.
