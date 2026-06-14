import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @import { AgentKind, AgentRunInput, AgentRunResult, KaizenLoopPayload } from "../types/contracts.js" */

const PAYLOAD_STATUSES = new Set(["fixed", "partial", "blocked"]);

const AGENT_PROVIDERS = {
  codex: {
    command: "codex",
    readsLastMessageFile: true,
    createArgs: codexArgs
  },
  claude: {
    command: "claude",
    readsLastMessageFile: false,
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
    const outputPath = join(tempDir, "last-message.txt");
    const provider = AGENT_PROVIDERS[agent];
    const args = provider.createArgs({ prompt, workspaceDir, model, outputPath });

    const result = await runCommand(provider.command, args, { cwd: workspaceDir, env });
    const lastMessage = provider.readsLastMessageFile ? await readFile(outputPath, "utf8").catch(() => "") : "";
    const raw = `${result.stdout}${result.stderr}\n${lastMessage}`;
    const payload = parseBuilderPayload(lastMessage || raw);

    return {
      exitCode: result.exitCode,
      raw,
      payload
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
  return value === "codex" ? "codex" : "claude";
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
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 */
function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
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
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
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
