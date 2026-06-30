# Builder Agent

Builder Agent is the implementation-focused component of Kaizen Agents. It turns an accepted issue or scoped task into code changes, reviews its own work, generates improvement instructions, and repeats until the result is ready for independent verification.

Builder Agent is deliberately not the final quality gate. Its self-review loop improves the implementation before external checks run, but approval remains the responsibility of mechanical verification, the independent verifier, repository policy, and human review where required.

## Build Flow

```mermaid
flowchart LR
    Request["build request<br/>task + goal + constraints"] --> Analyze["analyze task"]
    Analyze --> Plan["create plan"]
    Plan --> Implement["implement change"]
    Implement --> Review["self-review"]
    Review --> Ready{"ready?"}
    Ready -->|no| Improve["generate improvement instructions"]
    Improve --> Implement
    Ready -->|yes| Result["build-result.json<br/>self-review.json"]
```

Builder Agent's output is evidence for the next gates, not merge approval.

## Role in Kaizen Agents

Kaizen Agents separates responsibility across three main components:

- `kaizen-loop` coordinates intake, workspaces, retry loops, verification, risk decisions, commits, and pull requests.
- `builder-agent` implements tasks and runs an internal self-improvement loop.
- `verifier` independently evaluates the finished result and produces a gate verdict.

Builder Agent owns the build phase only.

```mermaid
flowchart LR
    A["Task / Issue"] --> B["Builder Agent"]
    B --> C["Code changes"]
    B --> D["Self-review report"]
    C --> E["Mechanical verification"]
    D --> E
    E --> F["Independent verifier"]
```

In the integrated flow, `kaizen-loop` owns workspace setup and GitHub operations. Builder Agent only edits the workspace and writes structured build evidence:

```mermaid
flowchart TB
    Loop["kaizen-loop"] -->|"stdin prompt"| Builder["builder-agent"]
    Loop -->|"KAIZEN_BUILD_RESULT_PATH"| Builder
    Builder -->|"runs provider<br/>Codex / Claude / custom"| Provider["implementation agent"]
    Provider --> Workspace["workspace code changes"]
    Builder --> Artifact["build-result.json<br/>discoveredIssues[]"]
    Artifact --> Loop
```

## MVP Scope

The current MVP includes both:

- A Codex-compatible skill that describes the implementation workflow.
- A small Node.js loop controller and CLI that can be called by Kaizen orchestration.

The MVP accepts:

- A task or issue description
- An optional goal
- Optional constraints
- A review threshold
- A maximum iteration count

It produces:

- Code changes in the current workspace
- A structured self-review report
- A final structured build result
- Structured discovered issues for separate bugs found during implementation

The final handoff must be reviewable by `kaizen-loop`, the independent verifier, and human reviewers. It should make clear what changed, why the change was made, which verification ran or was skipped, residual risk, and reviewer notes when relevant. This is implementation evidence only; it is not approval.

For standalone loop development, the CLI loads an adapter module that performs the task-specific implementation steps. For `kaizen-loop` integration, the same executable can also run as a thin command adapter around Claude Code or Codex and write the result contract expected by the orchestrator.

## Reusable TypeScript Boundaries

The source modules are implemented in TypeScript. `npm run build` emits JavaScript and declarations into `dist/` for runtime use and typed reuse.

Current boundaries:

- CLI (`src/cli.ts`): parses commands, environment, adapter paths, request JSON, and output paths.
- Contract layer (`src/types/`): owns normalized build request, build result, self-review, discovered issue, and adapter types.
- Agent runner (`src/agents/AgentRunner.ts`): invokes Codex or Claude behind a small provider interface.
- Builder service (`src/builder/BuilderAgent.ts`): orchestrates analyze, implement, review, and improve iterations without GitHub policy knowledge.
- Artifact writer (`src/artifacts.ts`): persists final and per-iteration handoff artifacts.

Generated declarations are published from `dist/index.d.ts`. The package entrypoint is `dist/index.js`, and the `builder-agent` bin points to `dist/cli.js`.

## Responsibility Boundaries

Builder Agent is responsible for:

- Understanding the requested task
- Inspecting the local repository
- Creating an implementation plan
- Implementing the smallest coherent change
- Adding or updating tests when appropriate
- Performing structured self-review
- Generating actionable improvement instructions
- Repeating implementation and review until the threshold is met or progress is blocked

Builder Agent is not responsible for:

- Creating pull requests
- Managing GitHub issues
- Making final approval decisions
- Performing independent verification
- Classifying release risk
- Replacing repository policy or human review

If Builder Agent discovers a separate bug while working, it reports that finding as structured data. The orchestrator decides whether and where to file a GitHub issue.

## Internal Loop

```mermaid
flowchart TB
    A["Analyze task"] --> B["Create plan"]
    B --> C["Implement"]
    C --> D["Self-review"]
    D --> E{"Passing conditions met?"}
    E -->|no| F["Generate improvement instructions"]
    F --> C
    E -->|yes| G["Ready for external verification"]
```

Default passing conditions:

- `score >= threshold`
- `mustFix.length === 0`
- `confidence >= 0.7`

`ready` means the result is ready to send to mechanical verification and the independent verifier. It does not mean the change is approved for merge.

## CLI Usage

Check installation:

```sh
npm run build
node dist/cli.js --version
```

Build typed output:

```sh
npm run build
```

Validate a request:

```sh
npm run validate:json
node dist/cli.js validate-request --request examples/build-request.example.json
```

`npm run validate:json` parses the published schemas and validates the checked-in examples against the same runtime contract used by the CLI. The schemas in `schemas/` are the MVP contract for orchestration boundaries:

- [build-request.schema.json](schemas/build-request.schema.json): input accepted by Builder Agent.
- [self-review.schema.json](schemas/self-review.schema.json): adapter self-review output before controller recomputes `passed`.
- [build-result.schema.json](schemas/build-result.schema.json): final artifact written for external verification handoff, including task understanding, changed files, review findings, and residual notes.
- [kaizen-loop-payload.schema.json](schemas/kaizen-loop-payload.schema.json): compact `fixed` / `partial` / `blocked` integration payload written through `KAIZEN_BUILD_RESULT_PATH`.

Run the builder loop with an adapter:

```sh
node dist/cli.js build \
  --request examples/build-request.example.json \
  --adapter examples/adapter.example.js \
  --out .kaizen/builder
```

The command writes:

- `.kaizen/builder/self-review.json`
- `.kaizen/builder/build-result.json`
- `.kaizen/builder/iterations/<n>/implementation-summary.json`
- `.kaizen/builder/iterations/<n>/self-review.json`
- `.kaizen/builder/iterations/<n>/improvement-instructions.json`
- `.kaizen/builder/iterations/<n>/residual-notes.json`

The top-level files always contain the latest/final handoff for compatibility. Each completed implementation/self-review iteration is also retained under `iterations/<n>/` so reviewers can inspect how the loop changed, converged, or became blocked.

Exit codes:

- `0`: ready
- `2`: blocked
- `3`: failed

## Kaizen Loop Integration

When `kaizen-loop` invokes `builder-agent`, it calls the command with no arguments, passes the implementation prompt on stdin, and expects a JSON result file.

```sh
KAIZEN_BUILD_RESULT_PATH=.kaizen/builder/build-result.json \
KAIZEN_WORKSPACE_DIR="$PWD" \
KAIZEN_PREFERRED_AGENT=codex,claude \
builder-agent < prompt.txt
```

Required environment:

- `KAIZEN_BUILD_RESULT_PATH`: file path where Builder Agent writes the orchestration result.

Optional environment:

- `KAIZEN_WORKSPACE_DIR`: repository workspace. Defaults to the current directory.
- `KAIZEN_PREFERRED_AGENT`: preferred backend or comma-separated fallback order, for example `codex,claude`. Defaults to `codex,claude`.
- `KAIZEN_AGENT_MODEL`: model name passed through to the selected backend.
- `KAIZEN_AGENT_PROVIDERS`: JSON object for custom backend providers.
- `KAIZEN_AGENT_PROVIDERS_FILE`: path to a JSON provider registry. Relative paths are resolved from `KAIZEN_WORKSPACE_DIR`.

Built-in providers:

- `claude`: runs `claude -p <prompt> --output-format json ...`.
- `codex`: runs `codex exec --json --sandbox workspace-write ...`.

If a provider exits or fails without returning a valid Builder Agent payload, Builder Agent classifies the failure before deciding whether to try the next provider. Default fallback classes are `command_missing`, `auth_failed`, `rate_limited`, `invalid_payload`, and `timeout`. `provider_blocked` stops fallback unless the provider explicitly opts in. Structured payloads are preserved even when the provider exits non-zero, so an intentional `blocked` result is not retried as an availability failure.

Custom providers make other agent CLIs usable without changing Builder Agent code:

```sh
KAIZEN_PREFERRED_AGENT=opencode-go,codex,claude \
KAIZEN_AGENT_PROVIDERS='{
  "opencode-go": {
    "command": "opencode-go",
    "args": ["run", "--cwd", "{{workspaceDir}}", "--model", "{{model}}", "{{prompt}}"],
    "output": "stdout"
  },
  "zai": {
    "command": "zai",
    "args": ["agent", "--workspace", "{{workspaceDir}}", "{{prompt}}"],
    "output": "stdout"
  }
}' \
builder-agent < prompt.txt
```

Provider `args` support `{{prompt}}`, `{{workspaceDir}}`, `{{model}}`, and `{{outputPath}}` placeholders. `{{model}}` renders as an empty value when `KAIZEN_AGENT_MODEL` is unset. `output` is `stdout` by default; use `last-message` for CLIs that write the final response to the `{{outputPath}}` file. Empty placeholder values are omitted; if the omitted value follows a flag-like argument such as `--model`, the flag is omitted too.

Provider registries can also live in a JSON file:

```sh
KAIZEN_PREFERRED_AGENT=hermes-agent,opencode-go,codex,claude \
KAIZEN_AGENT_PROVIDERS_FILE=.kaizen/agent-providers.json \
builder-agent < prompt.txt
```

The file may be either the provider object itself or `{ "providers": { ... } }`. Provider entries support:

- `command`: executable name or path.
- `args`: command arguments with `{{prompt}}`, `{{workspaceDir}}`, `{{model}}`, and `{{outputPath}}` placeholders.
- `promptTemplate`: provider-specific prompt wrapper. Defaults to `{{prompt}}`.
- `output`: `stdout` or `last-message`.
- `timeoutMs`: execution timeout.
- `healthCheck`: optional `{ "command", "args", "timeoutMs" }` check run before execution. Omitted `command` uses the provider command.
- `fallbackOn`: failure classes that should try the next provider.

Fallback evidence is included in blocked run notes and appended to successful fallback payload notes. It records attempted providers, failure classes, fallback reasons, selected backend, and final payload source.

See [provider-fallback-architecture.md](docs/provider-fallback-architecture.md) for the Hermes-style research notes, design decisions, and example registries for opencode-go, z.ai, Copilot-like wrappers, Antigravity-like wrappers, Grok-like wrappers, and Hermes-style agents.

The integration payload is intentionally smaller than the standalone build artifact:

```json
{
  "status": "fixed",
  "summary": "Short implementation summary.",
  "notes": "",
  "discoveredIssues": [
    {
      "title": "Verifier treats the word rejected in summaries as a hard failure",
      "repo": "verifier",
      "body": "The verifier rejected an otherwise passing run because the builder summary mentioned a legacy status name.",
      "expected": "Only actual verification failures should block PR creation.",
      "evidence": "verifier.log showed a must_fix from builder summary text."
    }
  ]
}
```

`status` is one of `fixed`, `partial`, or `blocked`. The `summary` should state what changed and why. The `notes` field should capture verification run or skipped, residual risk, and reviewer notes when relevant. `discoveredIssues` is optional and defaults to an empty array. The published contract is [kaizen-loop-payload.schema.json](schemas/kaizen-loop-payload.schema.json), and Builder Agent validates provider payloads with the same runtime normalizer before writing `KAIZEN_BUILD_RESULT_PATH`. `builder-agent` does not create pull requests, push branches, or file GitHub issues; those remain `kaizen-loop` responsibility.

## Adapter Contract

An adapter module must export either `createAdapter()` or an object with these async methods:

```js
export function createAdapter() {
  return {
    async analyzeTask({ request }) {},
    async createPlan({ request, analysis }) {},
    async implement({ request, analysis, plan, iteration }) {},
    async selfReview({ request, analysis, plan, implementation, iteration, threshold }) {},
    async improve({ request, analysis, plan, implementation, review, instructions, iteration }) {}
  };
}
```

`selfReview()` must return an object compatible with [self-review.schema.json](schemas/self-review.schema.json). The controller recomputes `passed` from the default passing conditions, so adapters cannot blindly approve themselves by setting `passed: true`.

## Repository Shape

```text
builder-agent/
├─ package.json
├─ SKILL.md
├─ src/
│  ├─ builder/
│  ├─ review/
│  └─ types/
├─ prompts/
│  ├─ analyze.md
│  ├─ implement.md
│  ├─ self-review.md
│  └─ improve.md
├─ schemas/
│  ├─ build-request.schema.json
│  ├─ build-result.schema.json
│  └─ self-review.schema.json
├─ examples/
│  ├─ adapter.example.js
│  ├─ build-request.example.json
│  ├─ build-result.example.json
│  └─ self-review.example.json
├─ test/
│  └─ builder-agent.test.js
└─ docs/
   └─ implementation-plan.md
```

See [Implementation Plan](docs/implementation-plan.md) for the proposed build order.
