# Provider Fallback Architecture Notes

Issue #24 asked for a Hermes-style comparison of provider registry, fallback, health-check, and output-adapter patterns. I did not find public Hermes Agents implementation docs that expose a concrete provider registry or fallback API, so the practical comparison used adjacent multi-provider agent products with public documentation:

- LiteLLM Router documents config-backed model lists, ordered fallbacks, retries, timeouts, cooldowns, and health-check-driven routing. It also separates fallback classes such as content-policy and context-window fallbacks from general error fallbacks. Sources: https://docs.litellm.ai/docs/routing and https://docs.litellm.ai/docs/proxy/reliability.
- OpenAI Agents SDK documents provider selection at global, run, and per-agent scope, third-party adapters, `MultiProvider` prefix routing, and retry policies that inspect normalized facts such as status code, timeout, and provider advice. Source: https://openai.github.io/openai-agents-python/models/.
- LangChain fallback material has moved in current docs, but the comparable pattern remains explicit alternate runnable/model chains. This was not adopted directly because builder-agent invokes local CLI tools, not in-process model clients.

## Gaps Found

- The provider registry was environment-only through `KAIZEN_AGENT_PROVIDERS`.
- Provider execution had no pre-run health check hook.
- Fallback decisions were based on absence of a valid payload, not on why the provider failed.
- Provider output handling was limited to stdout or Codex-style last-message files, with no prompt adapter.
- Successful fallback runs did not preserve a compact provider-attempt trail in the final payload.

## Adopted Decisions

- Keep `KAIZEN_PREFERRED_AGENT` and `KAIZEN_AGENT_PROVIDERS` unchanged for compatibility.
- Add `KAIZEN_AGENT_PROVIDERS_FILE` for a JSON provider registry. It accepts either the same provider object shape as `KAIZEN_AGENT_PROVIDERS` or `{ "providers": { ... } }`.
- Add optional per-provider `healthCheck`, `timeoutMs`, `promptTemplate`, and `fallbackOn`.
- Classify unstructured provider failures as `command_missing`, `auth_failed`, `rate_limited`, `invalid_payload`, `timeout`, or `provider_blocked`.
- Default fallback applies to `command_missing`, `auth_failed`, `rate_limited`, `invalid_payload`, and `timeout`. `provider_blocked` stops fallback unless the provider explicitly includes it in `fallbackOn`.
- Preserve structured provider payloads, including intentional `blocked` payloads, instead of retrying them as availability failures.
- Append provider evidence to `notes` when a later provider succeeds after fallback. Blocked all-provider failures already include the attempt trail in the blocked payload notes.

## Rejected Decisions

- No load balancing, cooldown registry, Redis state, or background health scheduler. `kaizen-loop` calls builder-agent once per issue, so a stateful router would add operational complexity without PR-first value.
- No GitHub operations in builder-agent. Issue linking, pushes, pull requests, and comments remain `kaizen-loop` responsibilities.
- No YAML parser dependency. JSON config is enough for the MVP and avoids dependency churn.
- No built-in provider-specific auth probes for Codex or Claude. Health checks are opt-in because CLI auth commands differ by installed version and can have side effects.

## Example Provider Registry

```json
{
  "providers": {
    "opencode-go": {
      "command": "opencode-go",
      "args": ["run", "--cwd", "{{workspaceDir}}", "--model", "{{model}}", "{{prompt}}"],
      "healthCheck": { "args": ["--version"], "timeoutMs": 5000 },
      "output": "stdout"
    },
    "zai": {
      "command": "zai",
      "args": ["agent", "--workspace", "{{workspaceDir}}", "{{prompt}}"],
      "fallbackOn": ["command_missing", "auth_failed", "rate_limited", "timeout", "invalid_payload"],
      "output": "stdout"
    },
    "copilot-wrapper": {
      "command": "copilot-agent",
      "args": ["run", "--repo", "{{workspaceDir}}", "--json-output", "{{outputPath}}", "{{prompt}}"],
      "output": "last-message"
    },
    "antigravity-wrapper": {
      "command": "antigravity",
      "args": ["task", "--workspace", "{{workspaceDir}}", "--model", "{{model}}", "{{prompt}}"],
      "promptTemplate": "Return only the Kaizen Loop JSON payload.\\n\\n{{prompt}}",
      "output": "stdout"
    },
    "grok-wrapper": {
      "command": "grok-agent",
      "args": ["exec", "--cwd", "{{workspaceDir}}", "{{prompt}}"],
      "healthCheck": { "args": ["doctor"], "timeoutMs": 10000 },
      "output": "stdout"
    },
    "hermes-agent": {
      "command": "hermes-agent",
      "args": ["run", "--workspace", "{{workspaceDir}}", "--out", "{{outputPath}}", "{{prompt}}"],
      "promptTemplate": "You are builder-agent. Do not push, open PRs, or file issues.\\n\\n{{prompt}}",
      "output": "last-message"
    }
  }
}
```

