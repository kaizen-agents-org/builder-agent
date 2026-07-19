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

If you discover a separate bug or Kaizen Agents workflow problem while implementing the task, do not fix it unless it is required for the current task. Record it in `discoveredIssues` with a title, evidence, expected behavior, and target repo or component when known. Optionally include a detailed body, severity, and labels. The orchestrator owns GitHub issue creation.

Before returning Kaizen Loop JSON, validate the complete payload against `schemas/kaizen-loop-payload.schema.json`. Include a non-empty `blockedReason` only when `status` is `blocked`; omit the field entirely for `fixed` and `partial` instead of emitting an empty string or `null`. Include `humanRequest` only when work is blocked on a concrete, unanswered human question or approval. It must contain a schema-defined `reasonCode`, a stable lowercase `requestKey` identifying the semantic decision, and the exact `question`. Keep `requestKey` unchanged when only wording changes; use a new key for a genuinely different decision. Ordinary automation failures, upstream work, retry exhaustion, and provider failures must not include it. Keep discovered issues in the final payload for every status. If a valid final payload cannot be produced, also preserve them in `.kaizen/builder/discovered-issues.json` and report the validation failure.

Do not perform GitHub operations, commits, pushes, PR creation, or final approval work as part of Builder Agent.

## Final Handoff

Produce reviewable implementation evidence for `kaizen-loop`, the independent verifier, and human reviewers. Populate the required `verification` array in the final build result with one entry per check, including the command, outcome, and concise evidence or the reason it was skipped. When writing structured iteration artifacts, write the same entries to `.kaizen/builder/iterations/<n>/verification.json`. The final result should also state what changed, why it changed, residual risk, and reviewer notes when relevant. Do not present the handoff as approval.
