# Implement Prompt

Implement the task after analysis.

## Planning

Create a short implementation plan before editing. Keep the plan scoped to the task and aligned with existing repository patterns.

The plan should identify:

- Files to change
- Behavior to add or modify
- Tests to add or update
- Local checks to run

## Editing Principles

Implement the smallest coherent change that satisfies the request.

- Prefer existing patterns, helpers, and architecture.
- Avoid unrelated refactors.
- Preserve unrelated user changes.
- Keep interfaces explicit and stable.
- Add comments only when they clarify non-obvious logic.
- Add or update tests when behavior, interfaces, or regressions are involved.

## Verification

Run targeted checks when practical. If checks cannot run, record why in the final result.

## Discovered Issues

If you discover a separate bug or Kaizen Agents workflow problem while implementing the task, do not fix it unless it is required for the current task. Record it in `discoveredIssues` with a title, evidence, expected behavior, and target repo or component when known. The orchestrator owns GitHub issue creation.

Do not perform GitHub operations, commits, pushes, PR creation, or final approval work as part of Builder Agent.

## Final Handoff

Produce reviewable implementation evidence for `kaizen-loop`, the independent verifier, and human reviewers. The final result should state what changed, why it changed, verification run or skipped with the reason, residual risk, and reviewer notes when relevant. Do not present the handoff as approval.
