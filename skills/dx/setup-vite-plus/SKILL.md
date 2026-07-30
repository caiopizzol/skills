---
name: setup-vite-plus
description: Set up or migrate a Vite-based application, library, or workspace to a minimal Vite+ toolchain with generated defaults, integrated checks, and basic commit hooks. Use for Vite+ setup, vp create, vp migrate, or replacing separate Vite, Vitest, lint, format, and hook tools.
---

# Set up Vite+

Use Vite+ as the integrated development, check, test, build, task, and basic hook toolchain. Prefer its
generated defaults over custom configuration.

## Workflow

1. Inspect the package manager, runtime, scripts, checks, tests, build, and hooks. Before a migration,
   run the existing commands to establish a baseline.
2. Run an exact Vite+ version and keep it pinned in the repository. Do not install it globally or change
   the machine's default Node.js version.
3. Preserve an existing package manager. Use pnpm for a new project.
4. Run one path:

   ```sh
   vp create <template> --directory <empty-target> --package-manager pnpm \
     --hooks --no-agent --no-editor --no-interactive

   vp migrate . --hooks --no-agent --no-editor --no-interactive
   ```

5. Keep the generated `vite.config.ts` unchanged unless the project requires otherwise. Do not leave an
   older tool and Vite+ owning the same concern. Stop if migration would lose existing behavior,
   downgrade a tool without approval, or require unsupported conversion work.

## Verify

```sh
vp install --frozen-lockfile
vp check
vp test
vp build
```

Run tests only when tests exist. Use `vp pack` instead of `vp build` for a library. Exercise one existing
behavior after migration. If hooks are enabled, verify `vp staged` in a scratch Git repository.

Report the Vite+ version, package manager, commands verified, configuration added beyond generated
defaults, replaced tools, and anything that remains unresolved.
