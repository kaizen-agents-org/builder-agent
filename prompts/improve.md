# Improve Prompt

Improve the implementation using the latest self-review.

## Inputs

Use:

- The current implementation
- The latest self-review
- `mustFix`
- `shouldFix`
- `improvementInstructions`
- Remaining iteration budget

## Improvement Rules

Address all `mustFix` items before `shouldFix` items.

- Turn each finding into a concrete code, test, or documentation change.
- Keep the fix scoped to the task.
- Avoid introducing unrelated refactors.
- Preserve unrelated user changes.
- If a finding is impossible to address safely, stop with `status = "blocked"` and explain the missing input or constraint.

After improving, run practical targeted checks and perform a new self-review.

Update the final handoff evidence so it remains accurate about what changed, why, residual risk, and reviewer notes. Refresh the required build-result `verification` array with one entry per check, including the command, outcome, and concise evidence or the reason it was skipped; when structured iteration artifacts are written, keep `.kaizen/builder/iterations/<n>/verification.json` in sync.

## Stopping Rule

If `maxIterations` is reached and the latest review still has `mustFix` items or fails the passing conditions, return `status = "blocked"` with residual notes and the latest self-review.
