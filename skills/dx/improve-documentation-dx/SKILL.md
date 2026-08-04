---
name: improve-documentation-dx
description: Assess or improve developer-facing documentation by tracing real reader tasks, finding evidence-backed friction, and proposing or applying the smallest useful changes. Use for READMEs, guides, references, or documentation sites where accuracy, navigation, examples, or progressive disclosure are the concern, not the codebase workflow except as documentation represents it.
---

# Improve documentation DX

Inspect the documentation and its authoritative sources before changing it. Infer the intended readers,
entry points, and tasks from the project and surrounding guidance. Unless the caller clearly asks for
implementation, propose changes and stop.

Trace representative reader tasks from their likely entry points. Check that the primary path is clear,
links and examples support it, and necessary detail is available without obscuring the next action.
Report only the highest-value findings. Distinguish friction reproduced by following the path or trying
an example from friction inferred from documentation evidence.

Do not shorten for brevity alone, remove necessary constraints or caveats, duplicate authoritative
information, or add pages or navigation without evidence that they simplify a real reader task. Preserve
the documentation's established voice and structure.

When implementing, keep the change focused and exercise the affected reader path afterward. Report what
improved, what verified it, and anything that remains uncertain.
