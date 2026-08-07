---
name: push-gh-stack-atomically
description: Publish rewritten branches of an existing GitHub PR Stack in one lease-guarded atomic Git push. Use after local Stack rebases when every affected branch already exists remotely and the caller has exact pre-change remote and post-change local SHAs. Do not use to create branches, PRs, or Stack membership.
---

# Push a GitHub Stack atomically

Require one remote and an explicit lease for every branch being updated. A lease contains the branch
name, the exact local commit to publish, and the remote commit observed before local mutation. Never
discover the expected remote SHA at push time and treat it as permission to overwrite that revision.

Run the bundled publisher from the repository worktree:

```sh
bun --no-env-file <skill-directory>/scripts/push.ts \
  --remote origin \
  --branch feature/foundation <local-sha> <expected-remote-sha> \
  --branch feature/consumer <local-sha> <expected-remote-sha>
```

The publisher verifies every local branch and remote lease, pushes the exact supplied commits through
one `git push --atomic`, and reads the remote heads back. After a failed push, it classifies the result
from those heads rather than ambiguous Git error wording: changed leases are `input-changed`, unchanged
leases are `provider-error`, and every requested head already present is verified success. Treat
`input-changed` as a stale observation: re-read the Stack and revalidate the intended changes instead of
retrying with fresh leases.

## Output

Report the remote, each branch's previous and pushed SHA, and one capability outcome: `ok`,
`tool-unavailable`, `unsupported-input`, `input-changed`, `timeout`, or `provider-error`.

## Boundaries

Do not fetch, rebase, create branches, create or edit PRs, alter Stack membership, reply to reviews,
mark PRs ready, or merge. Do not fall back to sequential pushes when atomic publication fails. Preserve
repository-specific authentication requirements before invoking the publisher.
