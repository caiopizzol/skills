---
name: setup-typescript
description: Set up, reconcile, or assess a repository's TypeScript configuration with TypeScript 7, minimal strict settings, inherited monorepo configs, and one root typecheck command. Use when creating TypeScript configuration, auditing whether it is correct, or completing it in a single package or monorepo.
---

# Set up TypeScript

Inspect the repository before changing it. Keep each configuration as small as possible. Preserve an
option only when the current runtime, framework, build, or source code requires it.

When the caller requests an assessment, report this capability as ready, gap, not-applicable, or
unverified with the evidence for it, then stop before changing anything.

## Configure

1. Pin the current TypeScript 7 release. If the repository's tooling does not support it, use the newest
   compatible version and report the constraint.
2. For a single package, keep one root `tsconfig.json`.
3. For a monorepo:
   - Put only shared compiler policy in a root `tsconfig.base.json`.
   - Give each TypeScript project under `apps/*` and `packages/*` a `tsconfig.json` that extends it.
   - Keep runtime-specific options in the project that needs them.
4. Use `strict` as the only universal compiler option. Add options such as `lib`, `module`,
   `moduleResolution`, `target`, or emit settings only when the project requires them.
5. Add one root `typecheck` script. In a monorepo, use the existing workspace or task runner to invoke
   every project's typecheck script.

Do not add project references, `composite`, path aliases, build tooling, formatting, linting, hooks,
tests, CI, or repository structure as part of this baseline. Add them later when a concrete need appears.

## Verify

In an isolated copy, remove every option beyond `strict`. Retain one only when current documentation or
a before-and-after comparison of applicable checks, coverage, output, and runtime behavior requires it;
generated defaults alone are not evidence.
Run the root `typecheck` script with the repository's package manager. Confirm it covers every configured
TypeScript project and leaves no untracked artifacts. Report existing errors instead of weakening the
configuration to hide them.

## Report

State the TypeScript version, configuration hierarchy, typecheck command, projects covered, and any
option added beyond `strict`, including why it was necessary.
