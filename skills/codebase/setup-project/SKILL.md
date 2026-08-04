---
name: setup-project
description: Assess or complete a project's toolchain, TypeScript, tests, and optional GitHub repository. Use when auditing an existing codebase, finishing an incomplete setup, or checking whether a project follows the standard setup.
---

# Set up a project

Coordinate the focused setup skills without recreating their procedures.

## Workflow

1. Inspect the project and resolve the request: assess only, or apply changes. Treat GitHub as in scope
   only when the repository has a remote or the caller asks for one.
2. Ask each applicable skill to assess: `$setup-vite-plus`, `$setup-typescript`, `$setup-tests`, and
   `$setup-gh-repo`.
3. Report each capability's state, the evidence behind it, and what applying it would change. Stop here
   when the caller asked to assess.
4. Otherwise reconcile only what is missing, in the order above. GitHub comes last because protection
   depends on checks observed on a real pull request.
5. Verify with the repository's root check, then report what changed and what is still unverified.

Honor each child's permission boundaries. When a child is unavailable, report its capability as
unverified rather than inspecting or reconciling that capability directly.
