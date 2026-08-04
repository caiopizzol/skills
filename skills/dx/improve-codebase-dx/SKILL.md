---
name: improve-codebase-dx
description: Assess or improve a codebase's developer experience by tracing real development tasks, finding evidence-backed friction, and proposing or applying the smallest useful changes. Use when reviewing repository organization or how developers run, change, or validate it, not whether its standard toolchain, testing, and GitHub foundations exist or whether its documentation reads clearly.
---

# Improve codebase DX

Inspect the repository before changing it. Infer the intended developers and their common tasks from
project guidance, manifests, scripts, automation, and structure. Unless the caller clearly asks for
implementation, propose changes and stop.

Trace representative tasks through the paths the project actually supports. Look for friction in
discoverability, navigation, setup, commands, feedback, and validation. Report only the highest-value
findings. Distinguish friction reproduced by exercising the task from friction inferred from repository
evidence, and state the affected task and smallest useful improvement.

Do not recommend changes from personal style alone, mistake missing optional technology for a DX gap,
or add tools, abstractions, documentation, or configuration without evidence that they simplify a real
developer task. Treat explicit project contracts as authoritative; a stricter hypothetical task is not
evidence of friction when the project does not claim to support it. Preserve established conventions.

When implementing, keep the change focused and exercise the affected task afterward. Report what
improved, what verified it, and anything that remains uncertain.
