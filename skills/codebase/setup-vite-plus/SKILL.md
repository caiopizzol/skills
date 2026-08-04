---
name: setup-vite-plus
description: Set up, migrate, reconcile, or assess a minimal Vite+ toolchain for an application, library, or workspace. Use for Vite+ setup, vp create, vp migrate, replacing separate Vite, Vitest, lint, format, and hook tools, or auditing whether Vite+ is implemented correctly.
---

# Set up Vite+

Use Vite+ as the integrated development toolchain. Prefer generated defaults over custom configuration.

When the caller requests an assessment, report this capability as ready, gap, not-applicable, or
unverified with the evidence for it, then stop before changing anything.

## Workflow

1. Inspect the existing toolchain. Preserve its package manager; for a new project use Bun unless the
   chosen template or toolchain does not support it, and report why another was necessary.
2. Select and pin an exact Vite+ version. Before installation, invoke `vp` through explicit package
   selection:

   ```sh
   bunx --package vite-plus@<version> vp <command>
   pnpm --package=vite-plus@<version> dlx vp <command>
   ```

3. For a new project, use the matching built-in template in an empty relative target. Enable Git and
   hooks, and avoid generating editor or agent configuration.

   ```sh
   vp create vite:application --directory <relative-target> --package-manager <manager> \
     --git --hooks --no-agent --no-editor --no-interactive
   ```

   `--git` initializes a repository on the generator's default branch and leaves the scaffold
   uncommitted. Report the branch name and that no commit exists; creating one belongs to the caller.

4. For a migration, report upstream divergence and the declared workspace boundary. Preview
   `vp migrate . --no-hooks --no-agent --no-editor --no-interactive` in a detached worktree at `HEAD`.
   Run the existing checks before it and `vp check` after it, then inspect the complete diff and version
   changes.
5. Get approval before applying broad formatting, semantic source changes, version changes, downgrades,
   or lost behavior. Treat declared workspace members as in scope; get approval before excluding them or
   changing topology. Split prerequisite upgrades or broad formatting when they can be qualified
   independently. Apply an approved migration in the caller with hooks enabled and remove tools that still
   own the same concern.

## Verify

```sh
vp install --frozen-lockfile
vp check
vp test
vp build
```

Run only applicable commands and use `vp pack` for a library. Run the final root check and every existing
test suite, retaining separate runners when needed. Do not disable formatting, linting, or type checking
merely to make migration pass. Verify `vp staged` in a scratch repository when hooks are enabled, and
keep hook lifecycle setup safe when development dependencies are omitted. Report only deviations from
generated defaults and anything left unverified.
