# The context note

Write `context-note.md` in the caller's artifacts directory with these sections:

- **Objective**: what the context is for.
- **Sources**: canonical identity, retrieval capability, authenticated identity, and acquired file path and
  SHA-256 for each source.
- **Understanding**: findings attributed to their sources.
- **Conflicts**: disagreements with each source's position preserved.
- **Deferred references**: optional and irrelevant items with reasons.
- **Gaps**: unretrieved, uninspected, or unavailable evidence with reasons.

Keep retrieval state separate from relevance. Put unsupported assumptions in Gaps, not Understanding.

Record what private evidence establishes, not the material itself. Attribute findings to a safe canonical
identity, but exclude credentials, signed URLs, private permalinks, and quoted or reproduced private
messages.

Do not commit the note, artifacts directory, or downloaded evidence.
