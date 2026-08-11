---
name: setup-cubic
description: Set up, simplify, or check Cubic code review for a GitHub repository. Use when enabling Cubic or creating the smallest useful cubic.yaml.
---

# Set up Cubic

Start with Cubic's defaults. Add only guidance this repository needs.

For a check-only request, report `ready`, `gap`, `not-applicable`, or `unverified` with evidence. Do not
change anything.

## Steps

1. Read Cubic's current `llms.txt` and configuration schema. They override remembered fields and defaults.
2. Check any `cubic.yaml`, README, agent instructions, and relevant docs. Get approval before replacing
   existing configuration.
3. Confirm the Cubic GitHub App is installed. Installing it and changing dashboard settings need separate
   permission.
4. Work on a non-default branch. Keep `version: 1` and write the smallest valid `cubic.yaml`. Set only
   repository-owned overrides. Omitted fields inherit organization YAML, dashboard settings, then defaults.
   Write no file when those defaults are enough.
5. Add short custom instructions only for a proven review gap that checks and Cubic's repository context
   do not cover. Add a custom agent only when that gap needs one.
6. Validate any file against the live schema. When used alone, open or update a pull request with
   permission. Under a parent skill, return the prepared change. Confirm Cubic accepts the file and reviews
   the pull request when the App is available.

Do not require Cubic for merging by default or copy general project docs into its configuration.
