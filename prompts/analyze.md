# Analyze Prompt

Analyze the build request before editing code.

## Inputs

Use the provided task, goal, constraints, threshold, and max iteration count. If a field is missing, apply the Builder Agent defaults from `SKILL.md`.

## Repository Inspection

Inspect the local repository enough to understand:

- Project language, framework, and package layout
- Existing conventions for architecture, tests, formatting, and naming
- The smallest likely set of files involved
- Available local verification commands
- Any user changes already present in the worktree

Do not overwrite or revert unrelated user changes.

## Output

Produce a concise analysis with:

- Interpreted task
- Success criteria
- Constraints
- Relevant files or areas
- Assumptions
- Potential blockers
- Verification options

If the request is too ambiguous to implement safely, stop with `status = "blocked"` and explain what input is needed.
