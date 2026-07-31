---
name: protect-gh-repo
description: Protect a GitHub repository's default branch using checks and review paths already observed on real pull requests. Use after CI and review integrations have run successfully, not while creating them.
---

# Protect a GitHub repository

Require only controls the repository has proved it can satisfy.

## Workflow

1. Inspect the default branch, classic protection, all effective repository and organization rulesets, recent pull requests, check runs, reviews, and the authenticated user's administration access. Stop if any effective protection cannot be read.
2. Identify the exact successful CI context and, when available, its producing GitHub App. Bind the requirement to both; never guess a context. For Cubic only, when the same real pull request head has both a `cubic-dev-ai[bot]` review and a successful check from the `cubic-dev-ai` GitHub App, require that exact app-bound check alongside CI. A bot comment without a successful check is not enforceable.
3. Preserve existing protections and use the narrowest supported mutation. Follow [GitHub's branch-protection API](references/github-api.md). Require pull requests, the observed CI check, and resolved conversations; block force pushes and branch deletion.
4. Require an approval only when a repository member or team can provide it without self-approval or an unavailable reviewer.
5. Read all effective rules back. Confirm a failing pull request is blocked when one exists. If approval is required, also confirm an unapproved pull request is blocked; report unavailable controls as unobserved.

Do not create workflows, install review tools, weaken existing protections, enforce a check that has not appeared successfully, or require review providers other than Cubic.
