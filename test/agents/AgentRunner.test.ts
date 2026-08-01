import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { normalizeKaizenLoopPayload, runImplementationAgent } from "../../dist/index.js";

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
  notes: "checked",
  blockedReason: "",
  discoveredIssues: [{
    title: "Follow-up issue",
    expected: "Keep the issue in the handoff.",
    evidence: "codex output"
  }]
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
    assert.equal(result.payload.blockedReason, undefined);
    assert.deepEqual(result.payload.discoveredIssues, [{
      title: "Follow-up issue",
      expected: "Keep the issue in the handoff.",
      evidence: "codex output"
    }]);
    assert.match(result.payload.notes, /checked/);
    assert.match(result.payload.notes, /codex: exitCode=0, status=selected, failureClass=none, fallbackReason=none, payloadSource=last-message/);
    assert.match(result.payload.notes, /Selected backend: codex/);
    assert.match(result.payload.notes, /Final payload source: last-message/);
    assert.deepEqual(args.slice(0, 7), [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--config",
      'approval_policy="never"',
      "-C"
    ]);
  });

  it("discovers the Desktop code-mode host without overriding an explicit host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const emptyBinDir = join(dir, "empty-bin");
    const binDir = join(dir, "bin");
    const desktopDir = join(dir, ".codex", "plugins", ".plugin-appserver");
    const envPath = join(dir, "host-path.txt");
    const explicitHostPath = join(dir, "explicit-host");
    await mkdir(emptyBinDir);
    await mkdir(binDir);
    await mkdir(desktopDir, { recursive: true });
    await writeFile(join(desktopDir, "codex-code-mode-host"), "#!/bin/sh\n", "utf8");
    await chmod(join(desktopDir, "codex-code-mode-host"), 0o755);
    await writeFile(explicitHostPath, "#!/bin/sh\n", "utf8");
    await chmod(explicitHostPath, 0o755);
    await writeFile(join(binDir, "codex"), `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(envPath)}, process.env.CODEX_CODE_MODE_HOST_PATH || "");
const outputIndex = args.indexOf("--output-last-message");
writeFileSync(args[outputIndex + 1], JSON.stringify({ status: "fixed", summary: "ok", notes: "" }));
`, "utf8");
    await chmod(join(binDir, "codex"), 0o755);

    await runImplementationAgent({
      agent: "codex",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: { ...process.env, HOME: dir, PATH: `${emptyBinDir}:${binDir}:${process.env.PATH}`, CODEX_CODE_MODE_HOST_PATH: undefined }
    });
    assert.equal(await readFile(envPath, "utf8"), join(desktopDir, "codex-code-mode-host"));

    await runImplementationAgent({
      agent: "codex",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: { ...process.env, HOME: dir, PATH: `${emptyBinDir}:${binDir}:${process.env.PATH}`, CODEX_CODE_MODE_HOST_PATH: explicitHostPath }
    });
    assert.equal(await readFile(envPath, "utf8"), explicitHostPath);

    await runImplementationAgent({
      agent: "codex",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: { ...process.env, HOME: dir, PATH: `${emptyBinDir}:${binDir}:${process.env.PATH}`, CODEX_CODE_MODE_HOST_PATH: join(dir, "missing-host") }
    });
    assert.equal(await readFile(envPath, "utf8"), join(desktopDir, "codex-code-mode-host"));
  });

  it("falls back to the next preferred backend when an agent fails without a payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented by fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeClaudePath, 0o755);

    const failureCases = [
      {
        name: "api key",
        output: "codex is not authenticated; api_key=top-secret",
        expectedDetail: /Failure detail: codex is not authenticated; api_key=\[REDACTED\]/,
        secrets: ["top-secret"],
        failureClass: "auth_failed"
      },
      {
        name: "authorization bearer",
        output: "codex is not authenticated; Authorization: Bearer bearer-secret",
        expectedDetail: /Failure detail: codex is not authenticated; Authorization: \[REDACTED\]/,
        secrets: ["bearer-secret"],
        failureClass: "auth_failed"
      },
      {
        name: "authorization basic",
        output: "codex is not authenticated; Authorization: Basic basic-secret",
        expectedDetail: /Failure detail: codex is not authenticated; Authorization: \[REDACTED\]/,
        secrets: ["basic-secret"],
        failureClass: "auth_failed"
      },
      {
        name: "quoted credential",
        output: 'codex is not authenticated; "client_secret"="quoted-secret"',
        expectedDetail: /Failure detail: codex is not authenticated; "client_secret"=\[REDACTED\]/,
        secrets: ["quoted-secret"],
        failureClass: "auth_failed"
      },
      {
        name: "quoted credential containing an escaped quote",
        output: 'codex is not authenticated; api_key="alpha\\"beta"',
        expectedDetail: /Failure detail: codex is not authenticated; api_key=\[REDACTED\]/,
        secrets: ['alpha\\"beta', "beta"],
        failureClass: "auth_failed"
      },
      {
        name: "URL credential",
        output: "codex is not authenticated; https://user:url-secret@example.test/path",
        expectedDetail: /Failure detail: codex is not authenticated; https:\/\/user:\[REDACTED\]@example\.test\/path/,
        secrets: ["url-secret"],
        failureClass: "auth_failed"
      },
      {
        name: "token-only URL credential",
        output: "codex is not authenticated; https://ghp_token-secret@example.test/path",
        expectedDetail: /Failure detail: codex is not authenticated; https:\/\/\[REDACTED\]@example\.test\/path/,
        secrets: ["ghp_token-secret", "token-secret"],
        failureClass: "auth_failed"
      },
      {
        name: "generic credential fields",
        output: "codex is not authenticated; token=token-secret auth_token=auth-secret access_key=access-secret secret=generic-secret",
        expectedDetail: /Failure detail: codex is not authenticated; token=\[REDACTED\] auth_token=\[REDACTED\] access_key=\[REDACTED\] secret=\[REDACTED\]/,
        secrets: ["token-secret", "auth-secret", "access-secret", "generic-secret"],
        failureClass: "auth_failed"
      },
      {
        name: "credential fields containing delimiters",
        output: "codex is not authenticated; password=alpha,beta token=gamma;delta",
        expectedDetail: /Failure detail: codex is not authenticated; password=\[REDACTED\] token=\[REDACTED\]/,
        secrets: ["alpha,beta", "beta", "gamma;delta", "delta"],
        failureClass: "auth_failed"
      },
      {
        name: "provider-prefixed credential fields",
        output: "codex is not authenticated; OPENAI_API_KEY=openai-secret GITHUB_TOKEN=github-secret AWS_SECRET_ACCESS_KEY=aws-secret",
        expectedDetail: /Failure detail: codex is not authenticated; OPENAI_API_KEY=\[REDACTED\] GITHUB_TOKEN=\[REDACTED\] AWS_SECRET_ACCESS_KEY=\[REDACTED\]/,
        secrets: ["openai-secret", "github-secret", "aws-secret"],
        failureClass: "auth_failed"
      },
      {
        name: "contextual bare credential",
        output: "Incorrect API key provided: sk-live-supersecret",
        expectedDetail: /Failure detail: Incorrect API key provided: \[REDACTED\]/,
        secrets: ["sk-live-supersecret"],
        failureClass: "auth_failed"
      },
      {
        name: "invalid payload",
        output: "provider returned invalid payload",
        expectedDetail: /Failure detail: provider returned invalid payload/,
        secrets: [],
        failureClass: "invalid_payload"
      }
    ] as const;

    for (const failureCase of failureCases) {
      await writeFile(
        fakeCodexPath,
        `#!/usr/bin/env node
console.error(${JSON.stringify(failureCase.output)} + " " + "x".repeat(400));
process.exit(1);
`,
        "utf8"
      );
      await chmod(fakeCodexPath, 0o755);

      const result = await runImplementationAgent({
        agent: "codex,claude",
        prompt: "Fix issue #1",
        workspaceDir: dir,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`
        }
      });

      assert.equal(result.exitCode, 0, failureCase.name);
      assert.equal(result.payload.summary, "implemented by fallback", failureCase.name);
      assert.match(result.payload.notes, new RegExp(`codex: exitCode=1, status=fallback, failureClass=${failureCase.failureClass}`), failureCase.name);
      assert.match(result.payload.notes, failureCase.expectedDetail, failureCase.name);
      for (const secret of failureCase.secrets) {
        assert.doesNotMatch(result.payload.notes, new RegExp(secret), failureCase.name);
      }
      const failureDetail = result.payload.notes.split("\n").find((line) => line.startsWith("  Failure detail: "));
      assert.ok(failureDetail, failureCase.name);
      assert.ok(failureDetail.length <= "  Failure detail: ".length + 240, failureCase.name);
      assert.match(result.payload.notes, /claude: exitCode=0, status=selected/, failureCase.name);
    }
  });

  it("preserves structured partial notes when provider failure details contain reserved labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("Verification: provider could not start");
process.exit(1);
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"partial\",\"summary\":\"implemented by fallback\",\"notes\":\"Completed scope: updated fallback handling. Incomplete scope: provider rollout remains. Verification: npm test passed. Residual risk: provider integration remains unverified.\"}\n```")}
}));
`,
      "utf8"
    );
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

    assert.equal(result.payload.status, "partial");
    assert.match(result.payload.notes, /Failure detail: Verification= provider could not start/);
    assert.doesNotThrow(() => normalizeKaizenLoopPayload(result.payload));
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

  it("does not append built-in providers to an explicit custom-only list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const codexMarkerPath = join(dir, "codex-called");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeCustomPath = join(binDir, "opencode-go");
    const fakeCodexPath = join(binDir, "codex");

    await writeFile(
      fakeCustomPath,
      `#!/usr/bin/env node
console.error("custom provider returned no payload");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
writeFileSync(${JSON.stringify(codexMarkerPath)}, "called");
})();
`,
      "utf8"
    );
    await chmod(fakeCustomPath, 0o755);
    await chmod(fakeCodexPath, 0o755);

    const result = await runImplementationAgent({
      agent: "opencode-go",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          "opencode-go": {
            command: "opencode-go",
            output: "stdout"
          }
        })
      }
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.payload, undefined);
    assert.match(result.providerEvidence, /opencode-go: exitCode=1, status=fallback, failureClass=invalid_payload/);
    await assert.rejects(readFile(codexMarkerPath, "utf8"));
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

  it("rejects unsupported custom provider fields from KAIZEN_AGENT_PROVIDERS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    try {
      const result = await runImplementationAgent({
        agent: "hermes-agent",
        prompt: "Fix issue #1",
        workspaceDir: dir,
        env: {
          ...process.env,
          KAIZEN_AGENT_PROVIDERS: JSON.stringify({
            "hermes-agent": {
              command: process.execPath,
              args: ["-e", "console.log('should not run')"],
              output: "stdout",
              extraSetting: true
            }
          })
        }
      });

      assert.equal(result.exitCode, 1);
      assert.equal(result.payload, undefined);
      assert.match(result.raw, /Provider "hermes-agent" has unsupported field: extraSetting/);
      assert.match(result.raw, /Supported fields: command, args, promptTemplate, output, timeoutMs, fallbackOn, healthCheck/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects invalid custom provider output values from KAIZEN_AGENT_PROVIDERS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    try {
      const result = await runImplementationAgent({
        agent: "hermes-agent",
        prompt: "Fix issue #1",
        workspaceDir: dir,
        env: {
          ...process.env,
          KAIZEN_AGENT_PROVIDERS: JSON.stringify({
            "hermes-agent": {
              command: process.execPath,
              args: ["-e", "console.log('should not run')"],
              output: "last_message"
            }
          })
        }
      });

      assert.equal(result.exitCode, 1);
      assert.equal(result.payload, undefined);
      assert.match(result.raw, /Provider "hermes-agent" output must be "stdout" or "last-message"/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects unsupported health check fields from KAIZEN_AGENT_PROVIDERS_FILE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const providerConfigPath = join(dir, "providers.json");
    try {
      await writeFile(
        providerConfigPath,
        JSON.stringify({
          providers: {
            "hermes-agent": {
              command: process.execPath,
              args: ["-e", "console.log('should not run')"],
              output: "stdout",
              healthCheck: {
                args: ["--version"],
                retries: 2
              }
            }
          }
        }),
        "utf8"
      );

      const result = await runImplementationAgent({
        agent: "hermes-agent",
        prompt: "Fix issue #1",
        workspaceDir: dir,
        env: {
          ...process.env,
          KAIZEN_AGENT_PROVIDERS_FILE: providerConfigPath
        }
      });

      assert.equal(result.exitCode, 1);
      assert.equal(result.payload, undefined);
      assert.match(result.raw, /Provider "hermes-agent" healthCheck has unsupported field: retries/);
      assert.match(result.raw, /Supported fields: command, args, timeoutMs/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
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

  it("terminates a provider process tree on timeout", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const childPidPath = join(dir, "child.pid");
    const childReadyPath = join(dir, "child-ready");
    const childSignalPath = join(dir, "child-signal-at");
    let childPid;

    try {
      const providerScript = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`const { writeFileSync } = require("node:fs"); process.once("SIGTERM", () => writeFileSync(${JSON.stringify(childSignalPath)}, String(Date.now()))); writeFileSync(${JSON.stringify(childReadyPath)}, "ready"); setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
setInterval(() => {}, 1000);
`;
      const resultPromise = runImplementationAgent({
        agent: "timeout-provider",
        prompt: "Fix issue #1",
        workspaceDir: dir,
        env: {
          ...process.env,
          KAIZEN_AGENT_PROVIDERS: JSON.stringify({
            "timeout-provider": {
              command: process.execPath,
              args: ["-e", providerScript],
              timeoutMs: 3_000,
              output: "stdout"
            }
          })
        }
      });

      childPid = Number(await waitForFile(childPidPath));
      await waitForFile(childReadyPath);
      const childSignalAtPromise = waitForFile(childSignalPath, 5_000);
      const result = await resultPromise;
      const settledAt = Date.now();
      const childSignalAt = Number(await childSignalAtPromise);
      assert.ok(settledAt - childSignalAt >= 900, "timeout cleanup should preserve the one-second SIGTERM grace period");
      assert.equal(result.exitCode, 1);
      assert.equal(result.payload, undefined);
      assert.match(result.providerEvidence, /timeout-provider: exitCode=1, status=fallback, failureClass=timeout/);
      assert.equal(await waitForProcessExit(childPid), true, `provider child ${childPid} remained alive after timeout`);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("terminates a detached provider process tree when the runner is signaled", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const childPidPath = join(dir, "child.pid");
    const runnerPath = join(dir, "runner.mjs");
    let childPid;
    let runner;

    try {
      const providerScript = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
setInterval(() => {}, 1000);
`;
      await writeFile(
        runnerPath,
        `
import { runImplementationAgent } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/index.js")).href)};
await runImplementationAgent({
  agent: "provider",
  prompt: "Fix issue #1",
  workspaceDir: ${JSON.stringify(dir)},
  env: {
    ...process.env,
    KAIZEN_AGENT_PROVIDERS: JSON.stringify({
      provider: {
        command: process.execPath,
        args: ["-e", ${JSON.stringify(providerScript)}],
        timeoutMs: 60_000,
        output: "stdout"
      }
    })
  }
});
`,
        "utf8"
      );

      runner = spawn(process.execPath, [runnerPath], { stdio: "ignore" });
      childPid = Number(await waitForFile(childPidPath));
      runner.kill("SIGTERM");
      await waitForChildExit(runner);

      assert.equal(await waitForProcessExit(childPid), true, `provider child ${childPid} remained alive after runner cancellation`);
    } finally {
      if (runner && runner.exitCode === null && runner.signalCode === null) {
        runner.kill("SIGKILL");
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("force-terminates a detached provider process tree when the runner exits", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const childPidPath = join(dir, "child.pid");
    const runnerPath = join(dir, "runner.mjs");
    let childPid;
    let runner;

    try {
      const providerScript = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
setInterval(() => {}, 1000);
`;
      await writeFile(
        runnerPath,
        `
import { runImplementationAgent } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/index.js")).href)};
setTimeout(() => process.exit(23), 500);
await runImplementationAgent({
  agent: "provider",
  prompt: "Fix issue #1",
  workspaceDir: ${JSON.stringify(dir)},
  env: {
    ...process.env,
    KAIZEN_AGENT_PROVIDERS: JSON.stringify({
      provider: {
        command: process.execPath,
        args: ["-e", ${JSON.stringify(providerScript)}],
        timeoutMs: 60_000,
        output: "stdout"
      }
    })
  }
});
`,
        "utf8"
      );

      runner = spawn(process.execPath, [runnerPath], { stdio: "ignore" });
      childPid = Number(await waitForFile(childPidPath));
      await waitForChildExit(runner);

      assert.equal(runner.exitCode, 23);
      assert.equal(await waitForProcessExit(childPid), true, `provider child ${childPid} remained alive after runner exit`);
    } finally {
      if (runner && runner.exitCode === null && runner.signalCode === null) {
        runner.kill("SIGKILL");
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("removes provider descendants before returning a successful result", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const childPidPath = join(dir, "child.pid");
    let childPid;

    try {
      const providerScript = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
child.unref();
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
console.log(JSON.stringify({status:"fixed",summary:"implemented",notes:"checked"}));
`;
      const result = await runImplementationAgent({
        agent: "provider",
        prompt: "Fix issue #1",
        workspaceDir: dir,
        env: {
          ...process.env,
          KAIZEN_AGENT_PROVIDERS: JSON.stringify({
            provider: {
              command: process.execPath,
              args: ["-e", providerScript],
              timeoutMs: 60_000,
              output: "stdout"
            }
          })
        }
      });

      childPid = Number(await waitForFile(childPidPath));
      assert.equal(result.payload.status, "fixed");
      assert.equal(await waitForProcessExit(childPid), true, `provider child ${childPid} remained alive after successful completion`);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("cleans up a successful provider group before inherited output pipes can delay close", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const childPidPath = join(dir, "child.pid");
    let childPid;

    try {
      const providerScript = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: ["ignore", "inherit", "inherit"] });
child.unref();
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
console.log(JSON.stringify({status:"fixed",summary:"implemented",notes:"checked"}));
`;
      const result = await runImplementationAgent({
        agent: "provider",
        prompt: "Fix issue #1",
        workspaceDir: dir,
        env: {
          ...process.env,
          KAIZEN_AGENT_PROVIDERS: JSON.stringify({
            provider: {
              command: process.execPath,
              args: ["-e", providerScript],
              timeoutMs: 2_000,
              output: "stdout"
            }
          })
        }
      });

      childPid = Number(await waitForFile(childPidPath));
      assert.equal(result.payload.status, "fixed");
      assert.equal(await waitForProcessExit(childPid), true, `provider child ${childPid} remained alive after successful completion`);
    } finally {
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back for command-missing, timeout, and rate-limited failures when fallbackOn opts in", async () => {
    for (const failureCase of failureClassificationCases) {
      const result = await runFailureClassificationFixture({
        failureCase,
        fallbackOn: [failureCase.failureClass]
      });

      assert.equal(result.exitCode, 0, failureCase.name);
      assert.equal(result.payload.status, "fixed", failureCase.name);
      assert.equal(result.payload.summary, "implemented after classified fallback", failureCase.name);
      assertClassifiedProviderEvidence(result.payload.notes, failureCase, "fallback");
      assert.match(result.payload.notes, /claude: exitCode=0, status=selected, failureClass=none/, failureCase.name);
      assert.match(result.payload.notes, /Selected backend: claude/, failureCase.name);
    }
  });

  it("stops fallback for command-missing, timeout, and rate-limited failures when fallbackOn opts out", async () => {
    for (const failureCase of failureClassificationCases) {
      const result = await runFailureClassificationFixture({
        failureCase,
        fallbackOn: []
      });

      assert.equal(result.payload, undefined, failureCase.name);
      assertClassifiedProviderEvidence(result.providerEvidence, failureCase, "stopped");
      assert.doesNotMatch(result.raw, /implemented after classified fallback/, failureCase.name);
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
  discoveredIssues: [{
    title: "Provider limit",
    severity: "medium",
    expected: "Provider fallback should avoid hard blocks when an alternate backend is available.",
    evidence: "codex exited with code 2 after reporting provider limit reached."
  }]
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
    assert.match(result.payload.notes, /captured provider detail/);
    assert.match(result.payload.notes, /Provider evidence:/);
    assert.match(result.payload.notes, /codex: exitCode=2, status=selected, failureClass=none, fallbackReason=none, payloadSource=last-message/);
    assert.match(result.payload.notes, /Selected backend: codex/);
    assert.match(result.payload.notes, /Final payload source: last-message/);
    assert.equal(result.payload.blockedReason, "provider limit reached");
    assert.deepEqual(result.payload.discoveredIssues, [{
      title: "Provider limit",
      severity: "medium",
      expected: "Provider fallback should avoid hard blocks when an alternate backend is available.",
      evidence: "codex exited with code 2 after reporting provider limit reached."
    }]);
  });
});

const failureClassificationCases = [
  {
    name: "ENOENT error code",
    failureClass: "command_missing",
    missingCommand: true,
    expectedEvidence: /hermes-agent: exitCode=1, status=(fallback|stopped), failureClass=command_missing/
  },
  {
    name: "command not found raw output",
    failureClass: "command_missing",
    stderr: "shell: command not found: missing-provider",
    expectedEvidence: /hermes-agent: exitCode=1, status=(fallback|stopped), failureClass=command_missing/
  },
  {
    name: "timed out raw output",
    failureClass: "timeout",
    stderr: "agent timed out while waiting for a response",
    expectedEvidence: /hermes-agent: exitCode=1, status=(fallback|stopped), failureClass=timeout/
  },
  {
    name: "timeout raw output",
    failureClass: "timeout",
    stderr: "agent timeout exceeded",
    expectedEvidence: /hermes-agent: exitCode=1, status=(fallback|stopped), failureClass=timeout/
  },
  {
    name: "429 raw output",
    failureClass: "rate_limited",
    stderr: "provider returned HTTP 429",
    expectedEvidence: /hermes-agent: exitCode=1, status=(fallback|stopped), failureClass=rate_limited/
  },
  {
    name: "rate limit raw output",
    failureClass: "rate_limited",
    stderr: "provider rate limit reached",
    expectedEvidence: /hermes-agent: exitCode=1, status=(fallback|stopped), failureClass=rate_limited/
  },
  {
    name: "too many requests raw output",
    failureClass: "rate_limited",
    stderr: "too many requests for this account",
    expectedEvidence: /hermes-agent: exitCode=1, status=(fallback|stopped), failureClass=rate_limited/
  },
  {
    name: "quota exceeded raw output",
    failureClass: "rate_limited",
    stderr: "quota exceeded for this project",
    expectedEvidence: /hermes-agent: exitCode=1, status=(fallback|stopped), failureClass=rate_limited/
  }
];

async function runFailureClassificationFixture({ failureCase, fallbackOn }) {
  const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
  const binDir = join(dir, "bin");
  try {
    await mkdir(binDir);

    const providerCommand = failureCase.missingCommand ? "missing-builder-agent-command" : "hermes-agent";
    if (!failureCase.missingCommand) {
      const fakeHermesPath = join(binDir, "hermes-agent");
      await writeFile(
        fakeHermesPath,
        `#!/usr/bin/env node
console.error(${JSON.stringify(failureCase.stderr)});
process.exit(1);
`,
        "utf8"
      );
      await chmod(fakeHermesPath, 0o755);
    }

    const fakeClaudePath = join(binDir, "claude");
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented after classified fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeClaudePath, 0o755);

    return await runImplementationAgent({
      agent: "hermes-agent,claude",
      prompt: "Fix issue #1",
      workspaceDir: dir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          "hermes-agent": {
            command: providerCommand,
            args: ["run", "{{prompt}}"],
            fallbackOn,
            output: "stdout"
          }
        })
      }
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function assertClassifiedProviderEvidence(evidence, failureCase, status) {
  assert.match(evidence, failureCase.expectedEvidence, failureCase.name);
  assert.match(evidence, new RegExp(`hermes-agent: exitCode=1, status=${status}`), failureCase.name);
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!isProcessAlive(pid)) return true;
    await delay(50);
  }
  return false;
}

async function waitForFile(path, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${path}`);
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform !== "win32") {
      const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
      if (state.startsWith("Z")) return false;
    }
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.status === 1) return false;
    throw error;
  }
}
