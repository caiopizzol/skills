---
name: setup-project
description: Create, assess, or complete a project's toolchain, TypeScript, tests, and optional GitHub repository. Use when starting a Vite+ project from scratch, auditing whether an existing project has these standard setup foundations, or completing missing foundations; not for reviewing broader developer experience or repository organization.
---

# Set up a project

Coordinate the focused setup skills without recreating their procedures.

## Workflow

1. Inspect the project and resolve the request: create, assess only, or apply changes. Treat GitHub as in
   scope only when a remote points at GitHub or the caller asks for one. Another host's remote is
   not-applicable, not a gap.
2. Ask each applicable skill to assess: `$setup-vite-plus`, `$setup-typescript`, `$setup-tests`, and
   `$setup-gh-repo`.
3. Report each capability's state, the evidence behind it, and what applying it would change. Stop here
   when the caller asked to assess.
4. Otherwise reconcile only what is missing, in the order above. GitHub comes last because protection
   depends on checks observed on a real pull request.
5. Verify with the repository's root check, then report what changed and what is still unverified.

Only a Vite+ project can be created here. Require an empty target, generate it with `$setup-vite-plus`,
then reconcile the remaining capabilities in the same order. Report any other requested stack as
unsupported instead of scaffolding it directly.

A generator may initialize Git without creating a commit and on a branch other than the intended default.
Set the intended default branch, then create the first commit with permission, before any GitHub work.

Honor each child's permission boundaries. When a child is unavailable, report its capability as
unverified rather than inspecting or reconciling that capability directly.
