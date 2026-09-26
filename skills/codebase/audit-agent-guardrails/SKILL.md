---
name: audit-agent-guardrails
description: Audit which of a repository's explicit rules are mechanically enforced and which exist only as written instructions, then pick one rule worth enforcing. Use to find enforcement gaps without changing code, not to enforce a rule already chosen.
---

# Audit agent guardrails

Audit one repository. Change nothing.

1. Read the repository instructions, architecture docs, root check, and CI configuration.
2. List three to five explicit rules that each prevent a concrete failure. Cite the source of each.
   Skip taste and unwritten assumptions.
3. For each rule, record the strongest layer you observe: an API or module boundary, a compiler,
   linter, or test, or only prose, review, or a skill. Call a rule enforced only when the violation
   is impossible or a normal repository check rejects it.
4. Pick the one gap with the clearest consequence that can be tested safely. Use
   `$enforce-codebase-constraint` in check-only mode on it.
5. Report each rule with its source and layer, the chosen gap, the check-only result, and what you
   did not inspect. Recommend enforcement; do not implement it.
