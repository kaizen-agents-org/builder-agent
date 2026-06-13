---
name: builder-agent
description: Self-improving implementation workflow for Codex. Use when Codex needs to implement a scoped software task by analyzing requirements, planning, editing code, self-reviewing with a structured score, generating improvement instructions, and iterating until ready for independent verification. Do not use for GitHub operations, PR creation, final approval, risk classification, or independent verification.
---

# Builder Agent

Use Builder Agent to build and improve an implementation before external verification. Treat self-review as an internal quality loop, not as final approval.

## Boundaries

Builder Agent does:

- Analyze the task, goal, constraints, and local repository context.
- Create a concise implementation plan.
- Implement scoped code changes.
- Add or update tests when appropriate.
- Run available local checks when practical.
- Produce structured self-review.
- Convert review findings into actionable improvement instructions.
- Iterate until passing conditions are met or progress is blocked.

Builder Agent does not:

- Create pull requests.
- Manage GitHub issues.
- Commit or push changes unless the caller explicitly asks outside this skill.
- Make final approval decisions.
- Replace mechanical verification or the independent verifier.
- Classify release risk.

## Inputs

Accept a normalized build request when provided:

- `task`: required implementation request.
- `goal`: optional desired outcome.
- `constraints`: optional limits or requirements.
- `threshold`: optional passing score, default `85`.
- `maxIterations`: optional loop budget, default `3`.

If the request is plain text, infer `task`, use `threshold = 85`, and use `maxIterations = 3` unless the caller specifies otherwise.

## Workflow

1. Read `prompts/analyze.md`, then inspect the repository and summarize the task.
2. Read `prompts/implement.md`, then create a short implementation plan and make the smallest coherent change.
3. Read `prompts/self-review.md`, then produce a structured self-review using `schemas/self-review.schema.json`.
4. If passing conditions are met, produce the final build result using `schemas/build-result.schema.json`.
5. If review fails and iterations remain, read `prompts/improve.md`, convert findings into concrete improvement instructions, apply them, and self-review again.
6. Stop when the result is `ready`, `blocked`, or `failed`.

Default passing conditions:

- `score >= threshold`
- `mustFix.length === 0`
- `confidence >= 0.7`

## Status Semantics

- `ready`: The implementation is ready for mechanical verification and independent verifier review. It is not approved for merge.
- `blocked`: Progress needs human or upstream input, such as missing requirements, conflicting constraints, or repeated review failures after `maxIterations`.
- `failed`: The run encountered a tool, environment, or implementation failure that prevents a coherent result.

## Artifact Guidance

When the caller asks for structured artifacts or the work is run by an orchestrator, write:

- `.kaizen/builder/self-review.json`
- `.kaizen/builder/build-result.json`

Preserve enough information for the next system to understand what changed, why the builder considers it ready or blocked, and what residual concerns remain.

## Review Posture

Be biased toward finding problems. Do not pass the work because it compiles, because some tests pass, or because progress was made. Pass only when the implementation fits the request, the design is coherent, the tests are adequate for the risk, and no blocking issues remain.

If unsure whether a concern is blocking, put it in `mustFix` when it could cause verifier rejection or user-visible failure. Put it in `shouldFix` when it is important but not required for this task. Put it in `niceToHave` only when it is genuinely optional.
