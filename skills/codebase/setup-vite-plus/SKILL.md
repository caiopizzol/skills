---
name: setup-vite-plus
description: Set up or migrate a Vite-based application, library, or workspace to a minimal Vite+ toolchain with generated defaults, integrated checks, and basic commit hooks. Use for Vite+ setup, vp create, vp migrate, or replacing separate Vite, Vitest, lint, format, and hook tools.
---

# Set up Vite+

Use Vite+ as the integrated development toolchain. Prefer generated defaults over custom configuration.

## Workflow

1. Inspect the existing toolchain. Preserve its package manager, or use pnpm for a new project.
2. Select and pin an exact Vite+ version. Before installation, invoke `vp` through explicit package
   selection:

   ```sh
   bunx --package vite-plus@<version> vp <command>
   pnpm --package=vite-plus@<version> dlx vp <command>
   ```

3. For a new project, use the matching built-in template in an empty relative target. Enable Git and
   hooks, and avoid generating editor or agent configuration.

   ```sh
   vp create vite:application --directory <relative-target> --package-manager pnpm \
     --git --hooks --no-agent --no-editor --no-interactive
   ```

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
