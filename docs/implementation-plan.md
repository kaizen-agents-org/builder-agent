# Builder Agent Implementation Plan

This plan starts with a skill-first MVP. The CLI should come later, after the prompt loop, review schema, and improvement behavior have been tested on real tasks.

## Goals

Builder Agent should behave like a senior implementation agent reviewing its own work before external verification.

It should:

- Understand a task and local repository context
- Create a concise implementation plan
- Implement scoped code changes
- Add or update tests when appropriate
- Produce structured self-review
- Convert review findings into actionable improvement instructions
- Iterate until the passing conditions are met or the run is blocked
- Return a final structured result

It should not:

- Create pull requests
- Operate on GitHub issues
- Make final approval decisions
- Replace independent verification
- Perform release risk analysis

## Phase 1: Skill MVP

Create a Codex-compatible `builder-agent` skill that can be invoked by an implementation agent.

Deliverables:

- `SKILL.md`
- `prompts/analyze.md`
- `prompts/implement.md`
- `prompts/self-review.md`
- `prompts/improve.md`
- JSON schemas for build requests, self-review, and build results
- Example request and review artifacts

Status: implemented in this repository.

The skill should define the complete loop:

```text
Analyze
Plan
Implement
Self-review
If review fails:
  Generate improvement instructions
  Improve implementation
  Self-review again
Repeat until passed or maxIterations is reached
```

## Phase 2: Structured Artifacts

Status: implemented in this repository.

Standardize the data contract used by the skill.

Initial request shape:

```ts
interface BuildRequest {
  task: string;
  goal?: string;
  constraints?: string[];
  threshold?: number;
  maxIterations?: number;
}
```

Initial result shape:

```ts
interface BuildResult {
  status: "ready" | "blocked" | "failed";
  iterations: number;
  planSummary: string;
  changedFiles: string[];
  review: SelfReviewResult;
  residualNotes: string[];
}
```

Initial self-review shape:

```ts
interface SelfReviewResult {
  score: number;
  confidence: number;
  dimensions: {
    requirementFit: number;
    architectureQuality: number;
    implementationQuality: number;
    testQuality: number;
    maintainability: number;
  };
  mustFix: string[];
  shouldFix: string[];
  niceToHave: string[];
  improvementInstructions: string[];
  passed: boolean;
}
```

Passing conditions:

```text
score >= threshold
mustFix.length === 0
confidence >= 0.7
```

## Phase 3: Prompt Hardening

Refine the prompts against real implementation tasks.

The self-review prompt should bias toward finding problems. Builder Agent should not pass itself simply because the code compiles or because it has made progress.

The review should evaluate:

- Requirement fit
- Architecture quality
- Implementation quality
- Test quality
- Maintainability

The improve prompt should turn review findings into concrete implementation work. It should not merely restate `mustFix` items.

## Phase 4: Integration With Kaizen Loop

After the skill is useful in manual runs, connect it to `kaizen-loop` as the build phase.

Expected integration contract:

- `kaizen-loop` provides a normalized build request.
- Builder Agent edits the isolated workspace.
- Builder Agent returns `build-result.json` and `self-review.json`.
- `kaizen-loop` runs mechanical verification.
- `kaizen-loop` sends the result to the independent verifier.

Builder Agent should not create branches, commits, pull requests, or issue comments.

## Phase 5: CLI Prototype

Status: implemented as the MVP loop controller and adapter-based CLI.

Only after the skill loop stabilizes, introduce a CLI wrapper.

The CLI does not change the responsibility model. It provides:

- Request parsing
- Artifact writing
- Iteration bookkeeping
- Exit codes for orchestration
- Adapter loading for implementation backends

Current command shape:

```sh
builder-agent build --request build-request.json --adapter ./adapter.js --out .kaizen/builder
```

Exit code model:

- `0`: ready
- `2`: blocked
- `3`: failed

## Open Questions

- Should `threshold` default to `80` or `85`?
- Should `shouldFix` items ever block readiness?
- How much test execution should the builder perform before handing off to mechanical verification?
- What adapter should `kaizen-loop` use for Codex execution in the first integration?

## Initial Recommendation

Start with the skill and schemas. Run it manually on a few small repositories before implementing the CLI. If the self-review and improve prompts produce useful changes, then formalize the loop controller.
