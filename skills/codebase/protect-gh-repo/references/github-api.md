# GitHub branch-protection API

Read GitHub's current REST docs before making changes. When the schema and live API disagree, trust the
live API.

## Existing protection

When only required checks are changing, use:

```text
PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks
```

Send the current `strict` value and the full wanted `checks` array. Include each check's observed `context`
and `app_id`. Do not send the old `contexts` field with `checks`.

This keeps reviews, resolved-conversation rules, admin enforcement, force-push rules, deletion rules, and
other protection unchanged.

## New protection

Use the full branch-protection endpoint only when the branch has no protection:

```text
PUT /repos/{owner}/{repo}/branches/{branch}/protection
```

Send App-bound `checks` without `contexts`. For a personal repository, omit `dismissal_restrictions` and
`bypass_pull_request_allowances`; user and team limits work only in organizations. Set top-level
`restrictions` to `null` when anyone with write access may push.

After either change, read branch protection and every active ruleset back. Confirm the exact check names,
App IDs, and preserved rules.
