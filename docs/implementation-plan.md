# Builder Agent Implementation Plan

Builder Agent now ships a Codex-compatible skill, structured artifact contracts, an adapter-based CLI, reusable TypeScript boundaries, and a Kaizen Loop command adapter. This plan records that implementation history and focuses current work on hardening the evidence passed between Builder Agent, mechanical verification, Kaizen Loop, and the independent verifier.

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

Settled MVP defaults:

- `threshold` defaults to `85` when omitted from the build request.
- `shouldFix` findings are retained for improvement instructions and reviewer context, but they do not block readiness by themselves.

## Phase 3: Prompt Hardening

Status: implemented as the initial self-review and improvement loop; ongoing hardening should be driven by evidence from real implementation tasks.

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

Status: implemented for the MVP command-adapter flow.

Current Kaizen Loop command-adapter contract:

- `kaizen-loop` passes the implementation prompt to `builder-agent` on stdin and sets `KAIZEN_BUILD_RESULT_PATH`.
- Builder Agent edits the isolated workspace.
- Builder Agent writes one normalized `KaizenLoopPayload` to `KAIZEN_BUILD_RESULT_PATH` and prints the same payload to stdout.
- `kaizen-loop` runs mechanical verification.
- `kaizen-loop` sends the result to the independent verifier.

This differs from the standalone adapter CLI described in Phase 5: `builder-agent build` reads a normalized build request and writes the detailed `build-result.json`, `self-review.json`, and per-iteration artifacts.

Builder Agent should not create branches, commits, pull requests, or issue comments.

## Phase 5: CLI Prototype

Status: implemented as the MVP loop controller and adapter-based CLI.

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

## Phase 6: TypeScript Source Migration

Status: implemented.

The migration preserves existing CLI behavior while making Builder Agent reusable outside Kaizen Agents. Source modules live in `src/**/*.ts`, and `npm run build` emits JavaScript and declaration output from `dist/`.

Boundary targets:

- CLI: parse command arguments, environment, request JSON, adapter paths, and output paths only.
- Contract layer: own typed build request, build result, self-review, discovered issue, Kaizen Loop payload, and adapter schemas.
- Agent runner: hide Codex/Claude command invocation behind a small provider interface.
- Builder service: orchestrate analyze, implement, self-review, and improve iterations without GitHub, issue selection, worktree, PR, mergeability, or repo policy knowledge.
- Artifact writer: persist final and per-iteration artifacts only.

Implemented migration:

- Converted `src` modules to TypeScript and disabled `allowJs`.
- Kept `.js` specifiers in TypeScript imports for NodeNext runtime output.
- Published package runtime entrypoints from `dist/index.js` and `dist/cli.js`.
- Exported contract aliases and runner functions from `dist/index.d.ts`.
- Added regression coverage that verifies source modules stay TypeScript, package entrypoints target `dist`, generated declarations expose the reusable boundaries, and CLI tests execute the built `dist/cli.js`.

## Open Questions

- Which verification commands should each provider be allowed to run, and how should skipped or failed checks be represented for downstream review?
- What additional artifact detail is needed for `kaizen-loop` and the independent verifier to distinguish a complete handoff from one that needs more implementation work?
- Which adapter and provider failure cases need more regression coverage to keep fallback behavior and structured results reliable?

## Current Recommendation

Treat the shipped skill, schemas, CLI, TypeScript package boundaries, and Kaizen Loop adapter as the baseline. Use real runs to improve adapter behavior, verification evidence, and final handoff artifacts while preserving the responsibility boundary: Builder Agent implements and reports evidence, and external verification remains independent.
