---
name: setup-gh-checks
description: Add or reconcile a minimal GitHub Actions validation workflow and require its successful status on the default branch. Use when a GitHub repository already has one local non-writing check command covering formatting, linting, and type checking.
---

# Set up GitHub checks

Make GitHub run the same validation developers run locally. Do not choose or install quality tools.

## Establish the check

1. Inspect the default branch, remote, package manager, lockfile, root scripts, existing workflows, and
   current rulesets or branch protection. Confirm `gh` has access to administer the repository.
2. Identify one root command that checks formatting without writing, lints, and typechecks. Expand every
   referenced script and confirm it invokes real configured tools. Do not accept names or exit code zero
   as evidence.
3. Run the command. In a disposable copy, introduce one representative formatting, lint, and type error
   and confirm each makes the command fail. Stop if any lane is missing, ineffective, or already failing;
   do not add tooling or weaken the command.
4. Use one stable, repository-unique job name. Prefer `check` unless a different workflow already reports
   that status context.

## Add the workflow

5. Create or reconcile `.github/workflows/check.yml` with:
   - `pull_request` and pushes to the actual default branch as triggers.
   - `contents: read` as the workflow token permission.
   - One job on `ubuntu-latest` that checks out the repository, installs the pinned package manager,
     installs from the frozen lockfile, and runs the root check command.
   - Readable action version pins such as `actions/checkout@v4`, not commit SHA pins.
6. Preserve the existing package manager and lockfile. Never use `pull_request_target`, secrets, write
   permissions, or formatting fix flags for this validation job.
7. Run the root check again and inspect the workflow diff. A local YAML parse does not prove that GitHub
   reports the expected status context.

## Enforce it

8. Push or open a pull request only when explicitly authorized. Wait until GitHub Actions reports the
   exact job context at least once; do not guess or require a context that has never appeared.
9. Preserve every existing protection and required check. Add the reported context with GitHub Actions
   as its expected source. If no protection exists, require pull requests, successful checks, and
   resolved conversations; include administrators and block force pushes and branch deletion. Do not
   add an approval count or strict up-to-date requirement unless requested.
10. Read the settings back from GitHub. Confirm the workflow passed on the pull-request head, the exact
   context is required on the default branch, and no previous restriction was weakened.

## Boundaries

Do not add linters, formatters, TypeScript, tests, builds, deployments, CodeQL, Dependabot, merge queues,
CODEOWNERS, or release automation. Do not report merge blocking as tested unless a real pull request or
GitHub response demonstrated it.
