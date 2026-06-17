import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @import { AgentKind, AgentProviderConfig, AgentRunInput, AgentRunResult, KaizenLoopPayload } from "../types/contracts.js" */

const PAYLOAD_STATUSES = new Set(["fixed", "partial", "blocked"]);
const DEFAULT_AGENT_TIMEOUT_MS = 600_000;

const AGENT_PROVIDERS = {
  codex: {
    command: "codex",
    output: "last-message",
    createArgs: codexArgs
  },
  claude: {
    command: "claude",
    output: "stdout",
    createArgs: claudeArgs
  }
};

/**
 * @param {AgentRunInput} input
 * @returns {Promise<AgentRunResult>}
 */
export async function runImplementationAgent({ agent, prompt, workspaceDir, model, env }) {
  const tempDir = await mkdtemp(join(tmpdir(), "builder-agent-"));

  try {
    const providers = loadAgentProviders(env);
    const agents = normalizeAgents(agent);
    const attempts = [];

    for (const agentName of agents) {
      const result = await runAgentAttempt({
        agent: agentName,
        provider: providers[agentName],
        prompt,
        workspaceDir,
        model,
        env,
        tempDir
      });

      if (result.payload) {
        return result;
      }

      attempts.push(result);
    }

    const lastAttempt = attempts.at(-1);
    return {
      exitCode: lastAttempt?.exitCode ?? 1,
      raw: attempts.map(formatAttempt).join("\n\n"),
      payload: undefined
    };
  } catch (error) {
    return {
      exitCode: 1,
      raw: error instanceof Error ? error.message : String(error),
      payload: undefined
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * @param {string | undefined} value
 * @returns {AgentKind}
 */
export function normalizeAgent(value) {
  return normalizeAgents(value)[0];
}

/**
 * @param {string | string[] | undefined} value
 * @returns {AgentKind[]}
 */
export function normalizeAgents(value) {
  const requested = Array.isArray(value) ? value : splitAgentList(value);
  const normalized = unique(requested.length ? requested : ["claude"]);

  for (const fallback of fallbackAgents(normalized)) {
    if (!normalized.includes(fallback)) normalized.push(fallback);
  }

  return normalized;
}

/**
 * @param {{
 *   agent: AgentKind,
 *   provider: ReturnType<typeof loadAgentProviders>[string] | undefined,
 *   prompt: string,
 *   workspaceDir: string,
 *   model?: string,
 *   env: NodeJS.ProcessEnv,
 *   tempDir: string
 * }} input
 * @returns {Promise<AgentRunResult & { agent: AgentKind }>}
 */
async function runAgentAttempt({ agent, provider, prompt, workspaceDir, model, env, tempDir }) {
  if (!provider) {
    return {
      agent,
      exitCode: 1,
      raw: `No provider is configured for agent "${agent}".`,
      payload: undefined
    };
  }

  try {
    const outputPath = join(tempDir, `${sanitizeFilename(agent)}-last-message.txt`);
    const args = provider.createArgs({ prompt, workspaceDir, model, outputPath });
    const result = await runCommand(provider.command, args, { cwd: workspaceDir, env });
    const lastMessage = provider.output === "last-message" ? await readFile(outputPath, "utf8").catch(() => "") : "";
    const raw = `${result.stdout}${result.stderr}\n${lastMessage}`;
    const payload = parseBuilderPayload(lastMessage || raw);

    return {
      agent,
      exitCode: result.exitCode,
      raw,
      payload
    };
  } catch (error) {
    return {
      agent,
      exitCode: 1,
      raw: error instanceof Error ? error.message : String(error),
      payload: undefined
    };
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 */
function loadAgentProviders(env) {
  return {
    ...AGENT_PROVIDERS,
    ...parseCustomProviders(env.KAIZEN_AGENT_PROVIDERS)
  };
}

/**
 * @param {string | undefined} raw
 * @returns {Record<string, { command: string, output: "stdout" | "last-message", createArgs(input: { prompt: string, workspaceDir: string, model?: string, outputPath: string }): string[] }>}
 */
function parseCustomProviders(raw) {
  if (!raw) return {};

  const parsed = parseMaybeJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KAIZEN_AGENT_PROVIDERS must be a JSON object.");
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([name, value]) => [name, createCustomProvider(name, value)])
  );
}

/**
 * @param {string} name
 * @param {unknown} value
 */
function createCustomProvider(name, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Provider "${name}" must be an object.`);
  }

  const config = /** @type {AgentProviderConfig} */ (value);
  if (typeof config.command !== "string" || !config.command.trim()) {
    throw new Error(`Provider "${name}" must define a command.`);
  }

  const args = Array.isArray(config.args) ? config.args : [];
  if (!args.every((arg) => typeof arg === "string")) {
    throw new Error(`Provider "${name}" args must be strings.`);
  }

  const output = config.output === "last-message" ? "last-message" : "stdout";
  return {
    command: config.command,
    output,
    createArgs: (input) => renderArgs(args, input)
  };
}

/**
 * @param {{ prompt: string, workspaceDir: string, model?: string, outputPath: string }} input
 */
function codexArgs({ prompt, workspaceDir, model, outputPath }) {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-C",
    workspaceDir,
    "--output-last-message",
    outputPath
  ];
  if (model) args.push("--model", model);
  args.push(prompt);
  return args;
}

/**
 * @param {{ prompt: string, model?: string }} input
 */
function claudeArgs({ prompt, model }) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(git add:*) Bash(git commit:*) Bash(npm:*) Read Write Edit Glob Grep"
  ];
  if (model) args.push("--model", model);
  return args;
}

/**
 * @param {string[]} args
 * @param {{ prompt: string, workspaceDir: string, model?: string, outputPath: string }} input
 */
function renderArgs(args, input) {
  const rendered = [];

  for (const arg of args) {
    const value = renderTemplate(arg, input);
    if (value.length > 0) {
      rendered.push({ source: arg, value });
      continue;
    }

    const previous = rendered.at(-1);
    if (previous && previous.value.startsWith("-")) {
      rendered.pop();
    }
  }

  return rendered.map((arg) => arg.value);
}

/**
 * @param {string} value
 * @param {{ prompt: string, workspaceDir: string, model?: string, outputPath: string }} input
 */
function renderTemplate(value, input) {
  return value
    .replaceAll("{{prompt}}", input.prompt)
    .replaceAll("{{workspaceDir}}", input.workspaceDir)
    .replaceAll("{{model}}", input.model ?? "")
    .replaceAll("{{outputPath}}", input.outputPath);
}

/**
 * @param {string | undefined} value
 */
function splitAgentList(value) {
  if (!value) return [];

  const parsed = value.trim().startsWith("[") ? parseMaybeJson(value) : undefined;
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => (typeof item === "string" ? [item] : []));
  }

  return value.split(/[,\s]+/);
}

/**
 * @param {string[]} values
 */
function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * @param {AgentKind[]} requested
 */
function fallbackAgents(requested) {
  const builtIns = ["claude", "codex"];
  return requested.some((agent) => builtIns.includes(agent))
    ? builtIns
    : ["claude", "codex"];
}

/**
 * @param {string} value
 */
function sanitizeFilename(value) {
  return value.replace(/[^a-z0-9._-]/gi, "_");
}

/**
 * @param {AgentRunResult & { agent?: AgentKind }} attempt
 */
function formatAttempt(attempt) {
  const header = attempt.agent ? `Agent "${attempt.agent}" exited with code ${attempt.exitCode}.` : `Agent exited with code ${attempt.exitCode}.`;
  return `${header}\n${attempt.raw}`;
}

/**
 * @param {string} raw
 * @returns {KaizenLoopPayload | undefined}
 */
function parseBuilderPayload(raw) {
  const topLevel = parseMaybeJson(raw);
  const finalText =
    topLevel && typeof topLevel === "object" && "result" in topLevel
      ? String(topLevel.result)
      : raw;
  const payload = parseMaybeJson(extractLastJsonObject(finalText));

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  if (!PAYLOAD_STATUSES.has(payload.status)) {
    return undefined;
  }

  return {
    status: payload.status,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    notes: typeof payload.notes === "string" ? payload.notes : "",
    discoveredIssues: normalizeDiscoveredIssues(payload.discoveredIssues),
    ...(typeof payload.blockedReason === "string" ? { blockedReason: payload.blockedReason } : {})
  };
}

/**
 * @param {unknown} value
 */
function normalizeDiscoveredIssues(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => normalizeDiscoveredIssue(item))
    .filter((item) => item !== undefined);
}

/**
 * @param {unknown} item
 */
function normalizeDiscoveredIssue(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const issue = /** @type {Record<string, unknown>} */ (item);
  if (typeof issue.title !== "string" || issue.title.trim().length === 0) return undefined;

  return {
    title: issue.title.trim(),
    ...(typeof issue.body === "string" && issue.body.trim() ? { body: issue.body.trim() } : {}),
    ...(typeof issue.expected === "string" && issue.expected.trim() ? { expected: issue.expected.trim() } : {}),
    ...(typeof issue.evidence === "string" && issue.evidence.trim() ? { evidence: issue.evidence.trim() } : {}),
    ...(typeof issue.repo === "string" && issue.repo.trim() ? { repo: issue.repo.trim() } : {}),
    ...(typeof issue.severity === "string" && issue.severity.trim() ? { severity: issue.severity.trim() } : {}),
    ...(Array.isArray(issue.labels) ? { labels: uniqueStrings(issue.labels) } : {})
  };
}

/**
 * @param {unknown[]} value
 */
function uniqueStrings(value) {
  return [
    ...new Set(value.flatMap((item) => {
      if (typeof item !== "string") return [];
      const trimmed = item.trim();
      return trimmed ? [trimmed] : [];
    }))
  ];
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number }} options
 */
function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle(() => {
        reject(timedOut ? new Error(`Agent command timed out after ${timeoutMs}ms.`) : error);
      });
    });
    child.on("close", (code) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`Agent command timed out after ${timeoutMs}ms.`));
          return;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  });
}

/**
 * @param {string} text
 */
function extractLastJsonObject(text) {
  const stripped = text.replace(/```(?:json)?/gi, "```");
  let depth = 0;
  let start = -1;
  let last = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        last = stripped.slice(start, index + 1);
        start = -1;
      }
    }
  }

  return last;
}

/**
 * @param {string} text
 */
function parseMaybeJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
