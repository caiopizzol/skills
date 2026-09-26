---
name: verify-surfaces
description: Check or build tests that pin every public surface of a repository (CLI commands, routes, tools, exports) to its exact output and outbound requests, so a change that breaks a surface fails. Use when adding or changing a surface, or to check whether a repository's surfaces are verified.
---

# Verify surfaces

A surface is anything used from outside the program: a CLI command, an HTTP route, an agent tool,
or a public export. Verify surfaces with tests, not documentation.

For a check-only request, report each surface as `verified`, `gap`, or `unverified`, with evidence.
Change nothing.

## Steps

1. List the surfaces from the code that declares them, such as a command table, route table, or
   tool registration. If no single declaration exists, refactor to one first. Prove the refactor
   changes nothing: record every mode's exit code, stdout, stderr, and outbound requests before and
   after, and require identical results.
2. Run each surface offline through a fixture that replaces the network. The fixture records every
   request before answering it, rejects requests the real service would reject (such as a missing
   token), and never records secrets.
3. Add one test that fails when a surface in the declaration has no test case. For each surface
   and output mode, assert:
   - the exact output (`toBe`), expected stderr, and exit code;
   - the exact outbound requests: method, origin, path, query, and relevant body fields;
   - that no secret appears in the output;
   - that each state-changing request happens only after its guard, such as a confirmation or scope
     check.
4. Prove each check can fail. In a copy, break the behavior it guards, confirm the source actually
   changed, and confirm the check fails. Explain any break that no check catches.
5. Report each surface's status, the controls and their results, and any known bug left untested.
   Do not assert a known bug as expected behavior.
