---
name: setup-vite-plus
description: Set up, migrate, or check Vite+ for an app, library, or workspace. Use for vp create, vp migrate, or replacing separate build, test, lint, format, and hook tools.
---

# Set up Vite+

Use Vite+ as the main development tool. Prefer generated defaults.

For a check-only request, report `ready`, `gap`, `not-applicable`, or `unverified` with evidence. Do not
change anything.

## Steps

1. Check the current tools. Keep the package manager. For a new project, use Bun unless the template or
   tools do not support it, and explain why another manager is needed.
2. Choose and pin an exact Vite+ version. Before installation, run `vp` through that exact package:

   ```sh
   bunx --package vite-plus@<version> vp <command>
   pnpm --package=vite-plus@<version> dlx vp <command>
   ```

3. For a new project, use the matching built-in template in an empty relative path. Enable Git and hooks.
   Do not create editor or agent files.

   ```sh
   vp create vite:application --directory <relative-target> --package-manager <manager> \
     --git --hooks --no-agent --no-editor --no-interactive
   ```

   `--git` creates an uncommitted repository on the generator's default branch. Report the branch name and
   that no commit exists. The user decides whether to commit.

4. For a migration, report changes from upstream and the workspace boundary. Preview
   `vp migrate . --no-hooks --no-agent --no-editor --no-interactive` in a detached worktree at `HEAD`.
   Run existing checks before it and `vp check` after it. Review the full diff and version changes.
5. Get approval before broad formatting, behavior changes, version changes, downgrades, lost behavior,
   excluding workspace members, or changing workspace structure. Split separate upgrades or formatting
   when possible. Apply an approved migration with hooks enabled and remove old tools that do the same job.

## Verify

```sh
vp install --frozen-lockfile
vp check
vp test
vp build
```

Run only commands that apply, and use `vp pack` for a library. Run the final root check and every existing
test suite. Keep separate runners when needed. Do not disable formatting, linting, or type checking to make
a migration pass. When hooks are enabled, test `vp staged` in a scratch repository and confirm hooks stay
safe when development dependencies are absent. Report changes from generated defaults and anything not
verified.
