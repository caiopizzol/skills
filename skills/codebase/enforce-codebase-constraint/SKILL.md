---
name: enforce-codebase-constraint
description: Turn one evidenced codebase rule into the smallest check that rejects a known violation, proven with a valid case and a violating case. Use when a known bad pattern should fail automatically, not for general code review.
---

# Enforce a codebase constraint

For a check-only request, report `enforced`, `gap`, or `unverified` with evidence. Change nothing.

1. State one rule, the failure it prevents, one valid case, and one violating case. Base it on an
   explicit requirement, a recurring review correction, or a demonstrated failure. If it is only taste,
   report `gap`.
2. Prefer making the violation impossible through an existing API, type, or module boundary. Otherwise
   use the closest existing compiler, linter, or test. Add no new tools or broad text bans.
3. In a copy, introduce the violation and confirm the check fails for the intended reason. Try obvious
   variants, such as case or path changes. A variant that passes is a `gap`; do not block valid code
   to close it.
4. Confirm the valid case and the repository's root check still pass.
5. Report the rule, where it is enforced, both control results, and any remaining gap. Use `enforced`
   only when the valid case passes, the violation fails, and no known variant gets through.
