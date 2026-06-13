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

## Stopping Rule

If `maxIterations` is reached and the latest review still has `mustFix` items or fails the passing conditions, return `status = "blocked"` with residual notes and the latest self-review.
