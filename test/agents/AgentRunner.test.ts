import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runImplementationAgent } from "../../dist/index.js";

describe("AgentRunner provider selection", () => {
  it("supports the kaizen-loop contract with the codex backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const argsPath = join(dir, "codex-args.json");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeCodexPath = join(binDir, "codex");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
const outputIndex = args.indexOf("--output-last-message");
writeFileSync(args[outputIndex + 1], JSON.stringify({
  status: "fixed",
  summary: "implemented with codex",
  notes: "checked"
}));
})();
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);

    const result = await runImplementationAgent({
      agent: "codex",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`
      }
    });
    const args = JSON.parse(await readFile(argsPath, "utf8"));

    assert.equal(result.exitCode, 0);
    assert.equal(result.payload.status, "fixed");
    assert.equal(result.payload.summary, "implemented with codex");
    assert.match(result.payload.notes, /checked/);
    assert.match(result.payload.notes, /codex: exitCode=0, status=selected, failureClass=none, fallbackReason=none, payloadSource=last-message/);
    assert.match(result.payload.notes, /Selected backend: codex/);
    assert.match(result.payload.notes, /Final payload source: last-message/);
    assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--sandbox", "workspace-write", "-C"]);
    assert.equal(args.includes("--ask-for-approval"), false);
  });

  it("falls back to the next preferred backend when an agent fails without a payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("codex is not authenticated");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented by fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const result = await runImplementationAgent({
      agent: "codex,claude",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`
      }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.payload.summary, "implemented by fallback");
    assert.match(result.payload.notes, /codex: exitCode=1, status=fallback, failureClass=auth_failed/);
    assert.match(result.payload.notes, /claude: exitCode=0, status=selected/);
  });

  it("returns aggregated attempt output when all preferred backends fail without a payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("codex failed " + "x".repeat(2500));
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.error("claude failed");
process.exit(1);
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const result = await runImplementationAgent({
      agent: "codex,claude",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.payload, undefined);
    assert.match(result.providerEvidence, /Provider evidence:/);
    assert.match(result.providerEvidence, /codex: exitCode=1, status=fallback, failureClass=invalid_payload, fallbackReason=invalid_payload, payloadSource=none/);
    assert.match(result.providerEvidence, /claude: exitCode=1, status=fallback, failureClass=invalid_payload, fallbackReason=invalid_payload, payloadSource=none/);
    assert.match(result.raw, /Agent "claude" exited with code 1/);
    assert.match(result.raw, /claude failed/);
  });

  it("runs custom providers from KAIZEN_AGENT_PROVIDERS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const argsPath = join(dir, "opencode-args.json");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeOpenCodePath = join(binDir, "opencode-go");

    await writeFile(
      fakeOpenCodePath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
console.log(JSON.stringify({
  status: "fixed",
  summary: "implemented by custom provider",
  notes: "checked"
}));
})();
`,
      "utf8"
    );
    await chmod(fakeOpenCodePath, 0o755);

    const result = await runImplementationAgent({
      agent: "opencode-go",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      model: "zai-coder",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          "opencode-go": {
            command: "opencode-go",
            args: ["run", "--cwd", "{{workspaceDir}}", "--model", "{{model}}", "{{prompt}}"],
            output: "stdout"
          }
        })
      }
    });
    const args = JSON.parse(await readFile(argsPath, "utf8"));

    assert.equal(result.payload.status, "fixed");
    assert.equal(result.payload.summary, "implemented by custom provider");
    assert.deepEqual(args, ["run", "--cwd", dir, "--model", "zai-coder", "Fix issue #1"]);
  });

  it("omits custom provider flag-value pairs when a placeholder value is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const argsPath = join(dir, "zai-args.json");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeZaiPath = join(binDir, "zai");

    await writeFile(
      fakeZaiPath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
console.log(JSON.stringify({
  status: "fixed",
  summary: "implemented without model",
  notes: "checked"
}));
})();
`,
      "utf8"
    );
    await chmod(fakeZaiPath, 0o755);

    await runImplementationAgent({
      agent: "zai",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          zai: {
            command: "zai",
            args: ["agent", "--workspace", "{{workspaceDir}}", "--model", "{{model}}", "{{prompt}}"],
            output: "stdout"
          }
        })
      }
    });
    const args = JSON.parse(await readFile(argsPath, "utf8"));

    assert.deepEqual(args, ["agent", "--workspace", dir, "Fix issue #1"]);
  });

  it("loads custom providers from KAIZEN_AGENT_PROVIDERS_FILE and applies prompt templates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const argsPath = join(dir, "hermes-args.json");
    const providerConfigPath = join(dir, "providers.json");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeHermesPath = join(binDir, "hermes-agent");

    await writeFile(
      fakeHermesPath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
console.log(JSON.stringify({
  status: "fixed",
  summary: "implemented by hermes-style provider",
  notes: "checked"
}));
})();
`,
      "utf8"
    );
    await writeFile(
      providerConfigPath,
      JSON.stringify({
        providers: {
          "hermes-agent": {
            command: "hermes-agent",
            args: ["run", "--input", "{{prompt}}"],
            promptTemplate: "Hermes task:\n{{prompt}}",
            output: "stdout"
          }
        }
      }),
      "utf8"
    );
    await chmod(fakeHermesPath, 0o755);

    const result = await runImplementationAgent({
      agent: "hermes-agent",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_AGENT_PROVIDERS_FILE: providerConfigPath
      }
    });
    const args = JSON.parse(await readFile(argsPath, "utf8"));

    assert.equal(result.payload.status, "fixed");
    assert.equal(result.payload.summary, "implemented by hermes-style provider");
    assert.deepEqual(args, ["run", "--input", "Hermes task:\nFix issue #1"]);
  });
});

describe("AgentRunner fallback classification", () => {
  it("falls back when a provider health check fails with a fallbackable class", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const fakeHermesPath = join(binDir, "hermes-agent");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeHermesPath,
      `#!/usr/bin/env node
if (process.argv[2] === "health") {
  console.error("401 unauthorized");
  process.exit(1);
}
console.log(JSON.stringify({
  status: "fixed",
  summary: "primary should not run",
  notes: "checked"
}));
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented after health-check fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeHermesPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const result = await runImplementationAgent({
      agent: "hermes-agent,claude",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          "hermes-agent": {
            command: "hermes-agent",
            args: ["run", "{{prompt}}"],
            healthCheck: { args: ["health"] },
            output: "stdout"
          }
        })
      }
    });

    assert.equal(result.payload.summary, "implemented after health-check fallback");
    assert.match(result.payload.notes, /Provider evidence/);
    assert.match(result.payload.notes, /hermes-agent: exitCode=1, status=fallback, failureClass=auth_failed/);
    assert.match(result.payload.notes, /Selected backend: claude/);
  });

  it("classifies fallbackable provider failure patterns", async () => {
    const cases = [
      { name: "command_missing", command: "missing-kaizen-provider-command", args: [], pattern: /failureClass=command_missing/ },
      { name: "auth_failed", command: process.execPath, args: ["-e", "console.error('login required'); process.exit(1);"], pattern: /failureClass=auth_failed/ },
      { name: "rate_limited", command: process.execPath, args: ["-e", "console.error('429 too many requests'); process.exit(1);"], pattern: /failureClass=rate_limited/ },
      { name: "invalid_payload", command: process.execPath, args: ["-e", "console.error('not json'); process.exit(1);"], pattern: /failureClass=invalid_payload/ },
      { name: "timeout", command: process.execPath, args: ["-e", "setTimeout(() => {}, 1000);"], timeoutMs: 10, pattern: /failureClass=timeout/ }
    ];

    for (const failureCase of cases) {
      const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
      const result = await runImplementationAgent({
        agent: `${failureCase.name}-provider,fallback`,
        prompt: "Fix issue #1",
        workspaceDir: dir,
        env: {
          ...process.env,
          KAIZEN_AGENT_PROVIDERS: JSON.stringify({
            [`${failureCase.name}-provider`]: {
              command: failureCase.command,
              args: failureCase.args,
              output: "stdout",
              ...(failureCase.timeoutMs ? { timeoutMs: failureCase.timeoutMs } : {})
            },
            fallback: {
              command: process.execPath,
              args: ["-e", "console.log(JSON.stringify({status:'fixed',summary:'fallback selected',notes:'checked'}));"],
              output: "stdout"
            }
          })
        }
      });

      assert.equal(result.payload.status, "fixed");
      assert.match(result.payload.notes, failureCase.pattern);
      assert.match(result.payload.notes, /fallback: exitCode=0, status=selected/);
    }
  });

  it("stops fallback for provider-blocked failures unless the provider opts in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("content policy safety refusal");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"should not fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const result = await runImplementationAgent({
      agent: "codex,claude",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.payload, undefined);
    assert.match(result.raw, /Failure class: provider_blocked/);
    assert.doesNotMatch(result.raw, /should not fallback/);
  });

  it("falls back when a provider emits an unrelated safety log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("project safety check failed");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"fallback after project safety check\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const result = await runImplementationAgent({
      agent: "codex,claude",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`
      }
    });

    assert.equal(result.payload.status, "fixed");
    assert.equal(result.payload.summary, "fallback after project safety check");
    assert.match(result.payload.notes, /codex: exitCode=1, status=fallback, failureClass=invalid_payload/);
    assert.match(result.payload.notes, /Selected backend: claude/);
  });

  it("falls back on provider-blocked failures when the provider opts in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const fakeHermesPath = join(binDir, "hermes-agent");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeHermesPath,
      `#!/usr/bin/env node
console.error("provider blocked by content policy");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented after provider-blocked fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeHermesPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const result = await runImplementationAgent({
      agent: "hermes-agent,claude",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          "hermes-agent": {
            command: "hermes-agent",
            args: ["run", "{{prompt}}"],
            fallbackOn: [" provider_blocked "],
            output: "stdout"
          }
        })
      }
    });

    assert.equal(result.payload.status, "fixed");
    assert.equal(result.payload.summary, "implemented after provider-blocked fallback");
    assert.match(result.payload.notes, /hermes-agent: exitCode=1, status=fallback, failureClass=provider_blocked, fallbackReason=provider_blocked/);
    assert.match(result.payload.notes, /claude: exitCode=0, status=selected, failureClass=none, fallbackReason=none/);
    assert.match(result.payload.notes, /Selected backend: claude/);
    assert.match(result.payload.notes, /Final payload source: stdout/);
  });

  it("preserves structured blocked payloads when the codex backend exits non-zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeCodexPath = join(binDir, "codex");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
writeFileSync(args[outputIndex + 1], JSON.stringify({
  status: "blocked",
  summary: "provider reported a structured block",
  notes: "captured provider detail",
  blockedReason: "provider limit reached",
  discoveredIssues: [{ title: "Provider limit", severity: "medium" }]
}));
process.exit(2);
})();
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);

    const result = await runImplementationAgent({
      agent: "codex",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`
      }
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.payload.status, "blocked");
    assert.equal(result.payload.summary, "provider reported a structured block");
    assert.equal(result.payload.notes, "captured provider detail");
    assert.equal(result.payload.blockedReason, "provider limit reached");
    assert.deepEqual(result.payload.discoveredIssues, [{ title: "Provider limit", severity: "medium" }]);
  });
});
