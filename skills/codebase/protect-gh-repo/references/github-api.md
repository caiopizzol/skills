# GitHub branch-protection API

Read GitHub's current REST documentation before writing. The live API behavior takes precedence when
its published schema is inconsistent.

## Existing protection

When only required checks change, use:

```text
PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks
```

Send the current `strict` value and the complete desired `checks` array. Bind each check with its
observed `context` and `app_id`. Do not send the deprecated `contexts` field with `checks`.

This endpoint preserves pull-request reviews, conversation resolution, administrator enforcement,
force-push policy, deletion policy, and other existing protection.

## New protection

Use the complete branch-protection endpoint only when protection does not exist:

```text
PUT /repos/{owner}/{repo}/branches/{branch}/protection
```

Send app-bound `checks` without `contexts`. For a personal repository, omit
`dismissal_restrictions` and `bypass_pull_request_allowances`; user and team restrictions are
organization-only. Set top-level `restrictions` to `null` when no push restriction is required.

After either mutation, read classic protection and all effective rulesets back from GitHub. Confirm
the exact contexts, app IDs, and every preserved control.
