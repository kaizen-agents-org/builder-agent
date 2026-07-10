# Self-Review Prompt

Review the implementation as a skeptical senior engineer before external verification.

Assume the implementation has flaws. Look for missed requirements, weak tests, unnecessary complexity, edge cases, maintainability issues, and places where mechanical verification or the independent verifier is likely to reject the change.

## Evaluate Dimensions

Score each dimension from `0` to `100`:

- `requirementFit`: Does the change satisfy the task, goal, and constraints?
- `architectureQuality`: Does it fit the repository structure and responsibility boundaries?
- `implementationQuality`: Is the code correct, robust, and appropriately scoped?
- `testQuality`: Are tests or verification adequate for the behavior and risk?
- `maintainability`: Is the result understandable and easy to evolve?

## Findings

Classify findings as:

- `mustFix`: Blocks readiness. Use for missed requirements, likely bugs, broken tests, unsafe behavior, or changes likely to be rejected by verification.
- `shouldFix`: Important improvement that does not block readiness for this task.
- `niceToHave`: Optional improvement.

Convert the blocking and important findings into `improvementInstructions`. Each instruction must be concrete enough to implement.

Flag any residual risk, skipped verification, assumptions, or reviewer notes that should appear in the final handoff.

## Output

Return JSON compatible with `schemas/self-review.schema.json`, except that `passed` may be omitted.

The controller always recomputes `passed` from the default passing conditions and ignores any adapter-supplied value:

- `score >= threshold`
- `mustFix.length === 0`
- `confidence >= 0.7`

Do not pass the work merely because it compiles, tests pass, or implementation progress was made.
