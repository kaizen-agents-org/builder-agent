import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { extractValidDiscoveredIssues, normalizeKaizenLoopPayload } from "../types/KaizenLoopPayload.js";
import type {
  AgentFailureClass,
  AgentKind,
  AgentProviderConfig,
  AgentRunInput,
  AgentRunResult,
  DiscoveredIssue,
  KaizenLoopPayload
} from "../types/contracts.js";

type AgentCommandInput = {
  prompt: string;
  workspaceDir: string;
  model?: string;
  outputPath: string;
};

type AgentProvider = {
  command: string;
  output: "stdout" | "last-message";
  promptOnStdin: boolean;
  renderPrompt?(input: AgentCommandInput): string;
  fallbackOn: AgentFailureClass[];
  timeoutMs?: number;
  healthCheck?: {
    command: string;
    args: string[];
    timeoutMs?: number;
  };
  createArgs(input: AgentCommandInput): string[];
};

type AgentAttempt = AgentRunResult & {
  agent: AgentKind;
  truncatedOutput?: Array<"stdout" | "stderr">;
};

type RenderedArg = {
  source: string;
  value: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stdoutTail?: string;
  stderr: string;
  stderrTail?: string;
  truncatedOutput: Array<"stdout" | "stderr">;
  observedFailureClass?: AgentFailureClass;
};

type BoundedOutputCapture = {
  head: string;
  headBytes: number;
  headComplete: boolean;
  tailBuffer?: Buffer;
  tailStart: number;
  tailBytes: number;
  totalBytes: number;
  classificationTail: string;
  classificationTailFragmented: boolean;
  observedFailureClass?: AgentFailureClass;
};

class CommandTimeoutError extends Error {
  constructor(timeoutMs: number, readonly result: CommandResult) {
    super(`Agent command timed out after ${timeoutMs}ms.`);
    this.name = "CommandTimeoutError";
  }
}

const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
const AGENT_TERMINATION_GRACE_MS = 1_000;
const PROVIDER_OUTPUT_CAPTURE_MAX_BYTES = 256 * 1024;
const PROVIDER_FAILURE_DETAIL_MAX_LENGTH = 240;
const DEFAULT_FALLBACK_ON: AgentFailureClass[] = ["command_missing", "auth_failed", "rate_limited", "invalid_payload", "timeout"];
const FAILURE_CLASSES = new Set([...DEFAULT_FALLBACK_ON, "provider_blocked"]);
const FAILURE_CLASS_PRECEDENCE: AgentFailureClass[] = ["command_missing", "timeout", "auth_failed", "rate_limited", "provider_blocked"];
const FAILURE_CLASS_LITERALS: Record<Exclude<AgentFailureClass, "invalid_payload">, string[]> = {
  command_missing: ["enoent", "not found", "command not found"],
  timeout: ["timed out", "timeout"],
  auth_failed: ["unauthorized", "unauthenticated", "not authenticated", "api key", "login required"],
  rate_limited: ["rate limit", "too many requests", "quota exceeded"],
  provider_blocked: ["content policy", "provider blocked", "safety refusal", "safety policy"]
};
const FAILURE_CLASS_SCAN_CARRY_LENGTH = Math.max(
  4,
  ...Object.values(FAILURE_CLASS_LITERALS).flat().map((value) => value.length)
);
const CUSTOM_PROVIDER_FIELDS = new Set(["command", "args", "promptTemplate", "promptOnStdin", "output", "timeoutMs", "fallbackOn", "healthCheck"]);
const HEALTH_CHECK_FIELDS = new Set(["command", "args", "timeoutMs"]);
const CLAUDE_VERIFICATION_TOOLS = ["npm", "pnpm", "yarn"].flatMap((command) => [
  `Bash(${command} test:*)`,
  `Bash(${command} run test:*)`,
  `Bash(${command} run lint:*)`,
  `Bash(${command} run check:*)`,
  `Bash(${command} run validate:*)`,
  `Bash(${command} run typecheck:*)`,
  `Bash(${command} run build:*)`
]);

const AGENT_PROVIDERS: Record<string, AgentProvider> = {
  codex: {
    command: "codex",
    output: "last-message",
    promptOnStdin: true,
    fallbackOn: DEFAULT_FALLBACK_ON,
    createArgs: codexArgs
  },
  claude: {
    command: "claude",
    output: "stdout",
    promptOnStdin: true,
    fallbackOn: DEFAULT_FALLBACK_ON,
    createArgs: claudeArgs
  }
};

export async function runImplementationAgent({ agent, prompt, workspaceDir, model, env }: AgentRunInput): Promise<AgentRunResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "builder-agent-"));

  try {
    const providers = await loadAgentProviders(env, workspaceDir);
    const agents = normalizeAgents(agent);
    const attempts: AgentAttempt[] = [];

    for (const agentName of agents) {
      const provider = providers[agentName];
      const result = await runAgentAttempt({
        agent: agentName,
        provider,
        prompt,
        workspaceDir,
        model,
        env,
        tempDir
      });

      if (result.payload) {
        const allAttempts = [...attempts, result];
        const recoveredIssues = collectDiscoveredIssues(allAttempts);
        const payload = recoveredIssues.length > 0
          ? { ...result.payload, discoveredIssues: mergeDiscoveredIssues(recoveredIssues, result.payload.discoveredIssues) }
          : result.payload;
        return {
          ...result,
          raw: formatAttempts(allAttempts),
          payload: shouldAppendProviderEvidence(payload) ? appendProviderEvidence(payload, allAttempts) : payload
        };
      }

      const fallbackReason = result.failureClass ?? "invalid_payload";
      const fallbackAllowed = shouldFallback(result, provider);
      const failedAttempt = { ...result, fallbackReason, fallbackAllowed };
      attempts.push(failedAttempt);
      if (!fallbackAllowed) {
        return {
          exitCode: result.exitCode,
          raw: formatAttempts(attempts),
          providerEvidence: formatProviderEvidence(attempts),
          discoveredIssues: collectDiscoveredIssues(attempts),
          payload: undefined
        };
      }
    }

    const lastAttempt = attempts.at(-1);
    return {
      exitCode: lastAttempt?.exitCode ?? 1,
      raw: formatAttempts(attempts),
      providerEvidence: attempts.length > 0 ? formatProviderEvidence(attempts) : undefined,
      discoveredIssues: collectDiscoveredIssues(attempts),
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

export function normalizeAgent(value: string | undefined): AgentKind {
  return normalizeAgents(value)[0] as AgentKind;
}

export function normalizeAgents(value: string | string[] | undefined): AgentKind[] {
  const requested = Array.isArray(value) ? value : splitAgentList(value);
  const normalized = unique(requested);
  return (normalized.length ? normalized : ["codex", "claude"]) as AgentKind[];
}

/**
 * @param {{
 *   agent: AgentKind,
 *   provider: Awaited<ReturnType<typeof loadAgentProviders>>[string] | undefined,
 *   prompt: string,
 *   workspaceDir: string,
 *   model?: string,
 *   env: NodeJS.ProcessEnv,
 *   tempDir: string
 * }} input
 * @returns {Promise<AgentRunResult & { agent: AgentKind }>}
 */
async function runAgentAttempt({ agent, provider, prompt, workspaceDir, model, env, tempDir }: {
  agent: AgentKind;
  provider: AgentProvider | undefined;
  prompt: string;
  workspaceDir: string;
  model?: string;
  env: NodeJS.ProcessEnv;
  tempDir: string;
}): Promise<AgentAttempt> {
  if (!provider) {
    return {
      agent,
      exitCode: 1,
      failureClass: "command_missing",
      raw: `No provider is configured for agent "${agent}".`,
      payload: undefined
    };
  }

  try {
    const outputPath = join(tempDir, `${sanitizeFilename(agent)}-last-message.txt`);
    if (provider.healthCheck) {
      const healthCheck = provider.healthCheck;
      const healthResult = await runCommand(
        healthCheck.command,
        renderArgs(healthCheck.args, { prompt, workspaceDir, model, outputPath }),
        { cwd: workspaceDir, env, timeoutMs: healthCheck.timeoutMs }
      );
      if (healthResult.exitCode !== 0) {
        const raw = `${healthResult.stdout}${healthResult.stderr}`;
        return {
          agent,
          exitCode: healthResult.exitCode,
          failureClass: healthResult.observedFailureClass ?? classifyFailure({ exitCode: healthResult.exitCode, raw }),
          payloadSource: "none",
          truncatedOutput: healthResult.truncatedOutput,
          raw,
          payload: undefined
        };
      }
    }

    const args = provider.createArgs({ prompt, workspaceDir, model, outputPath });
    const stdinPrompt = provider.promptOnStdin
      ? provider.renderPrompt?.({ prompt, workspaceDir, model, outputPath }) ?? prompt
      : undefined;
    const attemptEnv = agent === "codex" ? await withCodexCodeModeHost(env, provider.command) : env;
    const result = await runCommand(provider.command, args, {
      cwd: workspaceDir,
      env: attemptEnv,
      timeoutMs: provider.timeoutMs,
      stdin: stdinPrompt
    });
    const lastMessage = provider.output === "last-message" ? await readFile(outputPath, "utf8").catch(() => "") : "";
    const raw = `${result.stdout}${result.stderr}\n${lastMessage}`;
    const payloadSource = lastMessage ? "last-message" : "stdout";
    let parsedPayload = parseBuilderPayload(lastMessage || raw);
    if (!lastMessage) {
      const parsedStderrTail = result.stderrTail
        ? parseBuilderPayloadFragment(result.stderrTail)
        : undefined;
      if (parsedStderrTail?.payload) {
        parsedPayload = parsedStderrTail;
      } else if (!parseBuilderPayload(result.stderr).payload && result.stdoutTail) {
        const parsedStdoutTail = parseBuilderPayloadFragment(result.stdoutTail);
        if (parsedStdoutTail.payload) parsedPayload = parsedStdoutTail;
      }
    }
    const rawWithParseError = parsedPayload.error ? `${raw}\n${parsedPayload.error.message}` : raw;

    return {
      agent,
      exitCode: result.exitCode,
      failureClass: parsedPayload.payload
        ? undefined
        : preferFailureClass(
          result.observedFailureClass,
          classifyFailure({ exitCode: result.exitCode, raw: rawWithParseError })
        ) ?? "invalid_payload",
      payloadSource: parsedPayload.payload ? payloadSource : "none",
      truncatedOutput: result.truncatedOutput,
      raw: rawWithParseError,
      payload: parsedPayload.payload,
      discoveredIssues: parsedPayload.discoveredIssues
    };
  } catch (error) {
    const timeoutResult = error instanceof CommandTimeoutError ? error.result : undefined;
    const raw = timeoutResult
      ? `${timeoutResult.stdout}${timeoutResult.stderr}\n${(error as CommandTimeoutError).message}`
      : error instanceof Error ? error.message : String(error);
    return {
      agent,
      exitCode: 1,
      failureClass: error instanceof CommandTimeoutError ? "timeout" : classifyFailure({ exitCode: 1, raw, error }),
      payloadSource: "none",
      truncatedOutput: timeoutResult?.truncatedOutput,
      raw,
      payload: undefined
    };
  }
}

async function withCodexCodeModeHost(env: NodeJS.ProcessEnv, command: string): Promise<NodeJS.ProcessEnv> {
  if (env.CODEX_CODE_MODE_HOST_PATH && await isExecutableFile(env.CODEX_CODE_MODE_HOST_PATH)) return env;

  const commandPath = await resolveCommand(command, env.PATH);
  const candidates: string[] = [];
  if (commandPath) {
    candidates.push(join(dirname(commandPath), "codex-code-mode-host"));
    const resolvedCommand = await realpath(commandPath).catch(() => undefined);
    if (resolvedCommand) candidates.push(join(dirname(resolvedCommand), "codex-code-mode-host"));
  }
  if (env.HOME) {
    candidates.push(join(env.HOME, ".codex", "plugins", ".plugin-appserver", "codex-code-mode-host"));
  }

  for (const candidate of [...new Set(candidates)]) {
    if (await isExecutableFile(candidate)) {
      return { ...env, CODEX_CODE_MODE_HOST_PATH: candidate };
    }
  }
  return env;
}

async function isExecutableFile(path: string): Promise<boolean> {
  return Promise.all([access(path, constants.X_OK), stat(path)])
    .then(([, metadata]) => metadata.isFile(), () => false);
}

async function resolveCommand(command: string, pathValue: string | undefined): Promise<string | undefined> {
  if (isAbsolute(command)) return command;
  for (const directory of pathValue?.split(delimiter) ?? []) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} workspaceDir
 */
async function loadAgentProviders(env: NodeJS.ProcessEnv, workspaceDir: string): Promise<Record<string, AgentProvider>> {
  return {
    ...AGENT_PROVIDERS,
    ...parseCustomProviders(await readProviderFile(env.KAIZEN_AGENT_PROVIDERS_FILE, workspaceDir), "KAIZEN_AGENT_PROVIDERS_FILE"),
    ...parseCustomProviders(env.KAIZEN_AGENT_PROVIDERS)
  };
}

/**
 * @param {string | undefined} path
 * @param {string} workspaceDir
 * @returns {Promise<string | undefined>}
 */
async function readProviderFile(path: string | undefined, workspaceDir: string): Promise<string | undefined> {
  if (!path) return undefined;
  const resolved = isAbsolute(path) ? path : resolve(workspaceDir, path);
  return readFile(resolved, "utf8");
}

/**
 * @param {string | undefined} raw
 * @param {string} [source]
 * @returns {Record<string, { command: string, output: "stdout" | "last-message", fallbackOn: string[], timeoutMs?: number, healthCheck?: { command: string, args: string[], timeoutMs?: number }, createArgs(input: { prompt: string, workspaceDir: string, model?: string, outputPath: string }): string[] }>}
 */
function parseCustomProviders(raw: string | undefined, source = "KAIZEN_AGENT_PROVIDERS"): Record<string, AgentProvider> {
  if (!raw) return {};

  const parsed = parseMaybeJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} must be a JSON object.`);
  }
  const providerMap = normalizeProviderMap(parsed as Record<string, unknown>, source);

  return Object.fromEntries(
    Object.entries(providerMap).map(([name, value]) => [name, createCustomProvider(name, value)])
  );
}

/**
 * @param {Record<string, unknown>} parsed
 * @param {string} source
 */
function normalizeProviderMap(parsed: Record<string, unknown>, source: string): Record<string, unknown> {
  const providers = parsed.providers;
  if (providers !== undefined) {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
      throw new Error(`${source} providers must be an object.`);
    }
    return providers as Record<string, unknown>;
  }

  return parsed;
}

/**
 * @param {string} name
 * @param {unknown} value
 */
function createCustomProvider(name: string, value: unknown): AgentProvider {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Provider "${name}" must be an object.`);
  }

  const configRecord = value as Record<string, unknown>;
  assertKnownFields(configRecord, CUSTOM_PROVIDER_FIELDS, `Provider "${name}"`);
  const config = configRecord as unknown as AgentProviderConfig;
  if (typeof config.command !== "string" || !config.command.trim()) {
    throw new Error(`Provider "${name}" must define a command.`);
  }

  const args = Array.isArray(config.args) ? config.args : [];
  if (!args.every((arg) => typeof arg === "string")) {
    throw new Error(`Provider "${name}" args must be strings.`);
  }

  const promptTemplate = typeof config.promptTemplate === "string" && config.promptTemplate.trim()
    ? config.promptTemplate
    : "{{prompt}}";
  const output = normalizeProviderOutput(config.output, name);
  const promptOnStdin = normalizePromptOnStdin(config.promptOnStdin, name);
  const fallbackOn = normalizeFallbackOn(config.fallbackOn, name);
  const timeoutMs = normalizeTimeoutMs(config.timeoutMs, `Provider "${name}" timeoutMs`);
  return {
    command: config.command,
    output,
    promptOnStdin,
    renderPrompt: (input) => renderTemplate(promptTemplate, input),
    fallbackOn,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...createHealthCheck(config.healthCheck, config.command, name),
    createArgs: (input) => {
      const renderedPrompt = renderTemplate(promptTemplate, input);
      return renderArgs(args, { ...input, prompt: renderedPrompt });
    }
  };
}

function normalizePromptOnStdin(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw new Error(`Provider "${name}" promptOnStdin must be a boolean.`);
}

function assertKnownFields(value: Record<string, unknown>, allowedFields: Set<string>, label: string): void {
  const unsupportedFields = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unsupportedFields.length) {
    throw new Error(`${label} has unsupported field${unsupportedFields.length === 1 ? "" : "s"}: ${unsupportedFields.join(", ")}. Supported fields: ${[...allowedFields].join(", ")}.`);
  }
}

function normalizeProviderOutput(value: unknown, name: string): AgentProvider["output"] {
  if (value === undefined) return "stdout";
  if (value === "stdout" || value === "last-message") return value;
  throw new Error(`Provider "${name}" output must be "stdout" or "last-message".`);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function normalizeFallbackOn(value: unknown, name: string): AgentFailureClass[] {
  if (value === undefined) return DEFAULT_FALLBACK_ON;
  if (!Array.isArray(value)) {
    throw new Error(`Provider "${name}" fallbackOn must contain known failure classes.`);
  }
  const normalized = value.map((item) => (typeof item === "string" ? item.trim() : item));
  if (!normalized.every(isAgentFailureClass)) {
    throw new Error(`Provider "${name}" fallbackOn must contain known failure classes.`);
  }
  return [...new Set(normalized)];
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function normalizeTimeoutMs(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function isAgentFailureClass(value: unknown): value is AgentFailureClass {
  return typeof value === "string" && FAILURE_CLASSES.has(value);
}

/**
 * @param {unknown} value
 * @param {string} providerCommand
 * @param {string} name
 */
function createHealthCheck(value: unknown, providerCommand: string, name: string): Pick<AgentProvider, "healthCheck"> | Record<string, never> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Provider "${name}" healthCheck must be an object.`);
  }

  const healthCheckRecord = value as Record<string, unknown>;
  assertKnownFields(healthCheckRecord, HEALTH_CHECK_FIELDS, `Provider "${name}" healthCheck`);
  const healthCheck = healthCheckRecord as { command?: unknown, args?: unknown, timeoutMs?: unknown };
  const command = typeof healthCheck.command === "string" && healthCheck.command.trim()
    ? healthCheck.command
    : providerCommand;
  const args = Array.isArray(healthCheck.args) ? healthCheck.args : [];
  if (!args.every((arg) => typeof arg === "string")) {
    throw new Error(`Provider "${name}" healthCheck args must be strings.`);
  }
  const timeoutMs = normalizeTimeoutMs(healthCheck.timeoutMs, `Provider "${name}" healthCheck timeoutMs`);

  return {
    healthCheck: {
      command,
      args,
      ...(timeoutMs ? { timeoutMs } : {})
    }
  };
}

/**
 * @param {{ prompt: string, workspaceDir: string, model?: string, outputPath: string }} input
 */
function codexArgs({ workspaceDir, model, outputPath }: AgentCommandInput): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--config",
    'approval_policy="never"',
    "-C",
    workspaceDir,
    "--output-last-message",
    outputPath
  ];
  if (model) args.push("--model", model);
  args.push("-");
  return args;
}

/**
 * @param {{ prompt: string, model?: string }} input
 */
function claudeArgs({ model }: AgentCommandInput): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    [...CLAUDE_VERIFICATION_TOOLS, "Read", "Write", "Edit", "Glob", "Grep"].join(" ")
  ];
  if (model) args.push("--model", model);
  return args;
}

/**
 * @param {string[]} args
 * @param {{ prompt: string, workspaceDir: string, model?: string, outputPath: string }} input
 */
function renderArgs(args: string[], input: AgentCommandInput): string[] {
  const rendered: RenderedArg[] = [];

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
function renderTemplate(value: string, input: AgentCommandInput): string {
  return value
    .replaceAll("{{prompt}}", input.prompt)
    .replaceAll("{{workspaceDir}}", input.workspaceDir)
    .replaceAll("{{model}}", input.model ?? "")
    .replaceAll("{{outputPath}}", input.outputPath);
}

/**
 * @param {string | undefined} value
 */
function splitAgentList(value: string | undefined): string[] {
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
function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * @param {AgentKind[]} requested
 */
/**
 * @param {AgentRunResult & { failureClass?: string }} attempt
 * @param {{ fallbackOn?: string[] } | undefined} provider
 */
function shouldFallback(attempt: AgentRunResult, provider: AgentProvider | undefined): boolean {
  if (attempt.payload) return false;
  const failureClass = attempt.failureClass ?? "invalid_payload";
  const fallbackOn = provider?.fallbackOn ?? DEFAULT_FALLBACK_ON;
  return fallbackOn.includes(failureClass);
}

/**
 * @param {string} value
 */
function sanitizeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, "_");
}

/**
 * @param {AgentRunResult & { agent?: AgentKind, fallbackAllowed?: boolean, fallbackReason?: string }} attempt
 */
function formatAttempt(attempt: AgentRunResult & { agent?: AgentKind }): string {
  const header = attempt.agent ? `Agent "${attempt.agent}" exited with code ${attempt.exitCode}.` : `Agent exited with code ${attempt.exitCode}.`;
  const details = [
    attempt.failureClass ? `Failure class: ${attempt.failureClass}.` : undefined,
    attempt.fallbackReason ? `Fallback reason: ${attempt.fallbackReason}.` : undefined,
    typeof attempt.fallbackAllowed === "boolean" ? `Fallback allowed: ${attempt.fallbackAllowed ? "yes" : "no"}.` : undefined,
    attempt.payloadSource ? `Payload source: ${attempt.payloadSource}.` : undefined,
    attempt.payload ? `Selected backend: ${attempt.agent}.` : undefined
  ].filter(Boolean).join("\n");
  const metadata = `${header}${details ? `\n${details}` : ""}`;
  return attempt.raw ? `${attempt.raw}\n${metadata}` : metadata;
}

/**
 * @param {Array<AgentRunResult & { agent?: AgentKind, failureClass?: string, payloadSource?: string, fallbackAllowed?: boolean, fallbackReason?: string }>} attempts
 */
function formatAttempts(attempts: Array<AgentRunResult & { agent?: AgentKind }>): string {
  return attempts.map(formatAttempt).join("\n\n");
}

/**
 * @param {KaizenLoopPayload} payload
 * @param {Array<AgentRunResult & { agent?: AgentKind, failureClass?: string, payloadSource?: string, fallbackAllowed?: boolean, fallbackReason?: string }>} attempts
 */
function appendProviderEvidence(payload: KaizenLoopPayload, attempts: AgentAttempt[]): KaizenLoopPayload {
  const evidence = formatProviderEvidence(attempts);
  return {
    ...payload,
    notes: payload.notes ? `${payload.notes}\n\n${evidence}` : evidence
  };
}

function shouldAppendProviderEvidence(payload: KaizenLoopPayload): boolean {
  return payload.status === "fixed" || payload.status === "partial" || payload.status === "blocked";
}

/**
 * @param {Array<AgentRunResult & { agent?: AgentKind, failureClass?: string, payloadSource?: string, fallbackAllowed?: boolean, fallbackReason?: string }>} attempts
 */
function formatProviderEvidence(attempts: AgentAttempt[]): string {
  const selected = attempts.find((attempt) => attempt.payload);
  const lines = attempts.flatMap((attempt) => {
    const status = selected === attempt ? "selected" : attempt.fallbackAllowed ? "fallback" : "stopped";
    const truncatedOutput = attempt.truncatedOutput?.join(",") || "none";
    const summary = `- ${attempt.agent ?? "unknown"}: exitCode=${attempt.exitCode}, status=${status}, failureClass=${attempt.failureClass ?? "none"}, fallbackReason=${attempt.fallbackReason ?? "none"}, payloadSource=${attempt.payloadSource ?? "none"}, truncatedOutput=${truncatedOutput}`;
    const failureDetail = selected === attempt ? undefined : formatProviderFailureDetail(attempt.raw);
    return failureDetail ? [summary, `  Failure detail: ${failureDetail}`] : [summary];
  });
  return [
    "Provider evidence:",
    ...lines,
    ...(selected ? [`Selected backend: ${selected.agent ?? "unknown"}`, `Final payload source: ${selected.payloadSource ?? "unknown"}`] : [])
  ].join("\n");
}

function formatProviderFailureDetail(raw: string): string | undefined {
  const finalLine = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  if (!finalLine) return undefined;

  const redacted = redactSensitiveProviderOutput(finalLine)
    .replace(/\b(Completed scope|Incomplete scope|Verification|Residual risk)\s*:/gi, "$1=")
    .replace(/\s+/g, " ");

  return redacted.length > PROVIDER_FAILURE_DETAIL_MAX_LENGTH
    ? `${redacted.slice(0, PROVIDER_FAILURE_DETAIL_MAX_LENGTH - 1)}…`
    : redacted;
}

export function redactSensitiveProviderOutput(raw: string): string {
  return raw
    .replace(/(\bauthorization\b\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|.+)/gi, "$1[REDACTED]")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/((?<!\w)["']?(?:[a-z0-9]+[-_])*(?:api[-_ ]?key|access[-_ ]?(?:key|token)|auth[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|token|secret)["']?(?!\w)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*?)(?=\s+(?:(?<!\w)["']?(?:[a-z0-9]+[-_])*(?:api[-_ ]?key|access[-_ ]?(?:key|token)|auth[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|token|secret)["']?(?!\w)\s*[:=])|\r?$)/gim, "$1[REDACTED]")
    .replace(/(\b(?:api[-_ ]?key|access[-_ ]?(?:key|token)|auth[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|token|secret)\b\s+(?:provided|supplied|received|used|is|was)\s*:?\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^:@\s/]+@/gi, "$1[REDACTED]@");
}

/**
 * @param {{ exitCode: number, raw: string, error?: unknown }} input
 */
function classifyFailure({ exitCode, raw, error }: { exitCode: number, raw: string, error?: unknown }): AgentFailureClass {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const text = `${code}\n${raw}`.toLowerCase();
  return detectFailureClass(text) ?? "invalid_payload";
}

function detectFailureClass(text: string, endOfStream = true): AgentFailureClass | undefined {
  for (const failureClass of FAILURE_CLASS_PRECEDENCE) {
    if (failureClass === "auth_failed" && (endOfStream ? /\b401\b/ : /\b401\b(?=[\s\S])/).test(text)) return failureClass;
    if (failureClass === "rate_limited" && (endOfStream ? /\b429\b/ : /\b429\b(?=[\s\S])/).test(text)) return failureClass;
    if (FAILURE_CLASS_LITERALS[failureClass].some((value) => text.includes(value))) return failureClass;
  }
  return undefined;
}

function preferFailureClass(...classes: Array<AgentFailureClass | undefined>): AgentFailureClass | undefined {
  return FAILURE_CLASS_PRECEDENCE.find((failureClass) => classes.includes(failureClass));
}

/**
 * @param {string} raw
 * @returns {{ payload?: KaizenLoopPayload, discoveredIssues?: DiscoveredIssue[], error?: Error }}
 */
function parseBuilderPayload(raw: string): {
  payload?: KaizenLoopPayload;
  discoveredIssues?: DiscoveredIssue[];
  error?: Error;
} {
  const topLevel = parseMaybeJson(raw);
  const finalText =
    topLevel && typeof topLevel === "object" && "result" in topLevel
      ? String(topLevel.result)
      : raw;
  const payload = parseMaybeJson(extractLastJsonObject(finalText));

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  try {
    return { payload: normalizeKaizenLoopPayload(payload) };
  } catch (error) {
    return {
      discoveredIssues: extractValidDiscoveredIssues(payload),
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}

function parseBuilderPayloadFragment(raw: string): ReturnType<typeof parseBuilderPayload> {
  const parsed = parseBuilderPayload(raw);
  if (parsed.payload) return parsed;

  for (const escaped of [false, true]) {
    const candidate = extractLastJsonObject(raw, true, escaped);
    const resynchronized = parseBuilderPayload(candidate);
    if (resynchronized.payload) return resynchronized;
  }

  return parsed;
}

function collectDiscoveredIssues(attempts: AgentAttempt[]): DiscoveredIssue[] {
  return mergeDiscoveredIssues(...attempts.map((attempt) => attempt.discoveredIssues ?? []));
}

function mergeDiscoveredIssues(...issueGroups: DiscoveredIssue[][]): DiscoveredIssue[] {
  const seen = new Set<string>();

  return issueGroups.flat().filter((issue) => {
    const key = JSON.stringify([issue.repo ?? "", issue.title]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number, stdin?: string }} options
 */
function runCommand(command: string, args: string[], options: { cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number, stdin?: string }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const useProcessGroup = process.platform !== "win32";
    let timedOut = false;
    let settled = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let shutdownTimer: NodeJS.Timeout | undefined;
    let exitCleanup: Promise<void> | undefined;
    let pendingSettlement: (() => void) | undefined;
    let stdinError: Error | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: useProcessGroup
    });
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const cleanupProcessHandlers = () => {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      process.removeListener("exit", terminateOnExit);
    };
    const terminateOnExit = () => {
      terminateCommandTree(child, "SIGKILL", useProcessGroup);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateCommandTree(child, "SIGTERM", useProcessGroup);
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        terminateCommandTree(child, "SIGKILL", useProcessGroup);
        if (pendingSettlement) {
          const callback = pendingSettlement;
          pendingSettlement = undefined;
          cleanupProcessHandlers();
          callback();
        }
      }, AGENT_TERMINATION_GRACE_MS);
    }, timeoutMs);
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut && escalationTimer) {
        pendingSettlement = callback;
        return;
      }
      if (useProcessGroup || timedOut) terminateCommandTree(child, "SIGKILL", useProcessGroup);
      cleanupProcessHandlers();
      callback();
    };
    if (useProcessGroup) {
      for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
        const handler = () => {
          if (shutdownTimer) return;
          terminateCommandTree(child, signal, useProcessGroup);
          shutdownTimer = setTimeout(() => {
            terminateCommandTree(child, "SIGKILL", useProcessGroup);
            cleanupProcessHandlers();
            process.kill(process.pid, signal);
          }, AGENT_TERMINATION_GRACE_MS);
        };
        signalHandlers.set(signal, handler);
        process.once(signal, handler);
      }
      process.once("exit", terminateOnExit);
    }
    const stdout = createBoundedOutputCapture();
    const stderr = createBoundedOutputCapture();

    if (child.stdin) {
      child.stdin.on("error", (error) => {
        stdinError = error;
      });
      child.stdin.end(options.stdin);
    }

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => {
      appendBoundedOutput(stdout, chunk);
    });
    child.stderr!.on("data", (chunk) => {
      appendBoundedOutput(stderr, chunk);
    });
    child.once("exit", () => {
      if (timedOut) return;
      if (useProcessGroup) {
        terminateCommandTree(child, "SIGKILL", useProcessGroup);
      } else {
        exitCleanup = terminateCommandTreeAndWait(child, "SIGKILL", useProcessGroup);
      }
    });
    child.on("error", (error) => {
      if (timedOut) return;
      settle(() => {
        reject(error);
      });
    });
    child.on("close", async (code) => {
      await exitCleanup;
      settle(() => {
        const capturedStdout = renderBoundedOutput(stdout, "stdout");
        const capturedStderr = renderBoundedOutput(stderr, "stderr");
        const result: CommandResult = {
          exitCode: code ?? 1,
          stdout: capturedStdout.output,
          stdoutTail: capturedStdout.truncated ? capturedStdout.tail : undefined,
          stderr: capturedStderr.output,
          stderrTail: capturedStderr.truncated ? capturedStderr.tail : undefined,
          truncatedOutput: [
            ...(capturedStdout.truncated ? ["stdout" as const] : []),
            ...(capturedStderr.truncated ? ["stderr" as const] : [])
          ],
          observedFailureClass: preferFailureClass(
            stdout.observedFailureClass,
            detectFailureClass(finalClassificationText(stdout)),
            stderr.observedFailureClass,
            detectFailureClass(finalClassificationText(stderr))
          )
        };
        if (timedOut) {
          reject(new CommandTimeoutError(timeoutMs, result));
          return;
        }
        if (stdinError) {
          reject(stdinError);
          return;
        }
        resolve(result);
      });
    });
  });
}

function createBoundedOutputCapture(): BoundedOutputCapture {
  return {
    head: "",
    headBytes: 0,
    headComplete: false,
    tailStart: 0,
    tailBytes: 0,
    totalBytes: 0,
    classificationTail: "",
    classificationTailFragmented: false
  };
}

function appendBoundedOutput(capture: BoundedOutputCapture, chunk: string): void {
  const classificationText = `${capture.classificationTail}${chunk}`.toLowerCase();
  capture.observedFailureClass = preferFailureClass(
    capture.observedFailureClass,
    detectFailureClass(capture.classificationTailFragmented ? `x${classificationText}` : classificationText, false)
  );
  capture.classificationTailFragmented ||= classificationText.length > FAILURE_CLASS_SCAN_CARRY_LENGTH;
  capture.classificationTail = classificationText.slice(-FAILURE_CLASS_SCAN_CARRY_LENGTH);
  capture.totalBytes += Buffer.byteLength(chunk, "utf8");
  const headLimit = Math.floor(PROVIDER_OUTPUT_CAPTURE_MAX_BYTES / 2);
  const headRemainder = capture.headComplete
    ? 0
    : Math.max(0, headLimit - capture.headBytes);
  const headChunk = utf8Prefix(chunk, headRemainder);
  capture.head += headChunk;
  capture.headBytes += Buffer.byteLength(headChunk, "utf8");

  const tailChunk = chunk.slice(headChunk.length);
  const tailLimit = PROVIDER_OUTPUT_CAPTURE_MAX_BYTES - capture.headBytes;
  if (!tailChunk) return;

  capture.headComplete = true;
  appendTailBytes(capture, Buffer.from(tailChunk, "utf8"), tailLimit);
}

function appendTailBytes(capture: BoundedOutputCapture, chunk: Buffer, limit: number): void {
  if (!capture.tailBuffer) capture.tailBuffer = Buffer.allocUnsafe(limit);

  if (chunk.length >= limit) {
    chunk.copy(capture.tailBuffer, 0, chunk.length - limit);
    capture.tailStart = 0;
    capture.tailBytes = limit;
    return;
  }

  const overflow = Math.max(0, capture.tailBytes + chunk.length - limit);
  capture.tailStart = (capture.tailStart + overflow) % limit;
  capture.tailBytes -= overflow;

  const writeOffset = (capture.tailStart + capture.tailBytes) % limit;
  const firstLength = Math.min(chunk.length, limit - writeOffset);
  chunk.copy(capture.tailBuffer, writeOffset, 0, firstLength);
  if (firstLength < chunk.length) chunk.copy(capture.tailBuffer, 0, firstLength);
  capture.tailBytes += chunk.length;
}

function renderTail(capture: BoundedOutputCapture): string {
  if (!capture.tailBuffer || capture.tailBytes === 0) return "";

  const ordered = Buffer.allocUnsafe(capture.tailBytes);
  const firstLength = Math.min(capture.tailBytes, capture.tailBuffer.length - capture.tailStart);
  capture.tailBuffer.copy(ordered, 0, capture.tailStart, capture.tailStart + firstLength);
  if (firstLength < capture.tailBytes) {
    capture.tailBuffer.copy(ordered, firstLength, 0, capture.tailBytes - firstLength);
  }

  let start = 0;
  while (start < ordered.length && (ordered[start] & 0xc0) === 0x80) start += 1;
  return ordered.subarray(start).toString("utf8");
}

function finalClassificationText(capture: BoundedOutputCapture): string {
  return capture.classificationTailFragmented ? `x${capture.classificationTail}` : capture.classificationTail;
}

function renderBoundedOutput(
  capture: BoundedOutputCapture,
  stream: "stdout" | "stderr"
): { output: string, tail: string, truncated: boolean } {
  const capturedTail = renderTail(capture);
  if (capture.totalBytes <= PROVIDER_OUTPUT_CAPTURE_MAX_BYTES) {
    const output = `${capture.head}${capturedTail}`;
    return { output, tail: output, truncated: false };
  }

  const largestMarker = `\n[builder-agent: ${stream} truncated; omitted ${capture.totalBytes} bytes]\n`;
  const retainedBytes = PROVIDER_OUTPUT_CAPTURE_MAX_BYTES - Buffer.byteLength(largestMarker, "utf8");
  const head = utf8Prefix(capture.head, Math.floor(retainedBytes / 2));
  const tail = utf8Suffix(capturedTail, retainedBytes - Buffer.byteLength(head, "utf8"));
  const omittedBytes = capture.totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  const marker = `\n[builder-agent: ${stream} truncated; omitted ${omittedBytes} bytes]\n`;
  return {
    output: `${head}${marker}${tail}`,
    tail,
    truncated: true
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;

  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function utf8Suffix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;

  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function terminateCommandTreeAndWait(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
  useProcessGroup: boolean
): Promise<void> {
  if (process.platform !== "win32" || child.pid === undefined) {
    terminateCommandTree(child, signal, useProcessGroup);
    return Promise.resolve();
  }

  return new Promise((resolveTermination) => {
    const taskkillArgs = ["/pid", String(child.pid), "/t"];
    if (signal === "SIGKILL") taskkillArgs.push("/f");
    const taskkill = spawn("taskkill", taskkillArgs, { stdio: "ignore", windowsHide: true });
    taskkill.once("error", () => {
      child.kill(signal);
      resolveTermination();
    });
    taskkill.once("close", () => resolveTermination());
  });
}

function terminateCommandTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals, useProcessGroup: boolean): void {
  if (child.pid === undefined) return;

  if (process.platform === "win32") {
    const taskkillArgs = ["/pid", String(child.pid), "/t"];
    if (signal === "SIGKILL") taskkillArgs.push("/f");
    spawn("taskkill", taskkillArgs, { stdio: "ignore", windowsHide: true }).on("error", () => {
      child.kill(signal);
    });
    return;
  }

  try {
    if (useProcessGroup) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      child.kill(signal);
    }
  }
}

/**
 * @param {string} text
 */
function extractLastJsonObject(text: string, initialInString = false, initialEscaped = false): string {
  const stripped = text.replace(/```(?:json)?/gi, "```");
  let depth = 0;
  let start = -1;
  let last = "";
  let inString = initialInString;
  let escaped = initialEscaped;

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
      if (depth === 0) {
        start = -1;
        continue;
      }
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
function parseMaybeJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
