---
name: setup-typescript
description: Set up or check a small, strict TypeScript configuration for one package or a monorepo, with one root typecheck command.
---

# Set up TypeScript

Check the repository first. Keep each configuration small. Keep an option only when the runtime,
framework, build, or code needs it.

For a check-only request, report `ready`, `gap`, `not-applicable`, or `unverified` with evidence. Do not
change anything.

## Configure

1. Pin the current TypeScript 7 release. If the tools do not support it, use the newest compatible version
   and explain why.
2. For a single package, keep one root `tsconfig.json`.
3. For a monorepo:
   - Put only shared compiler rules in a root `tsconfig.base.json`.
   - Give each TypeScript project under `apps/*` and `packages/*` a `tsconfig.json` that extends it.
   - Keep runtime-specific options in the project that needs them.
4. Use `strict` as the only option every project gets. Add `lib`, `module`, `moduleResolution`, `target`,
   or output settings only where needed.
5. Add one root `typecheck` script. In a monorepo, use the existing workspace or task runner to invoke
   every project's typecheck script.

Do not add project references, `composite`, path aliases, build tools, formatting, linting, hooks, tests,
CI, or new folders without a clear need.

## Verify

In an isolated copy, remove every option beyond `strict`. Keep one only when current docs or a before and
after check proves it is needed. Generated defaults are not proof.

Run the root `typecheck` command with the repository's package manager. Confirm it covers every TypeScript
project and leaves no new files. Report existing errors instead of weakening the settings.

## Report

Report the TypeScript version, configuration structure, typecheck command, projects covered, and why each
option beyond `strict` is needed.
