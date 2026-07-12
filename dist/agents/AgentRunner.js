import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeKaizenLoopPayload } from "../types/KaizenLoopPayload.js";
const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
const DEFAULT_FALLBACK_ON = ["command_missing", "auth_failed", "rate_limited", "invalid_payload", "timeout"];
const FAILURE_CLASSES = new Set([...DEFAULT_FALLBACK_ON, "provider_blocked"]);
const CUSTOM_PROVIDER_FIELDS = new Set(["command", "args", "promptTemplate", "output", "timeoutMs", "fallbackOn", "healthCheck"]);
const HEALTH_CHECK_FIELDS = new Set(["command", "args", "timeoutMs"]);
const AGENT_PROVIDERS = {
    codex: {
        command: "codex",
        output: "last-message",
        fallbackOn: DEFAULT_FALLBACK_ON,
        createArgs: codexArgs
    },
    claude: {
        command: "claude",
        output: "stdout",
        fallbackOn: DEFAULT_FALLBACK_ON,
        createArgs: claudeArgs
    }
};
export async function runImplementationAgent({ agent, prompt, workspaceDir, model, env }) {
    const tempDir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    try {
        const providers = await loadAgentProviders(env, workspaceDir);
        const agents = normalizeAgents(agent);
        const attempts = [];
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
                return {
                    ...result,
                    raw: formatAttempts(allAttempts),
                    payload: shouldAppendProviderEvidence(result.payload) ? appendProviderEvidence(result.payload, allAttempts) : result.payload
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
                    payload: undefined
                };
            }
        }
        const lastAttempt = attempts.at(-1);
        return {
            exitCode: lastAttempt?.exitCode ?? 1,
            raw: formatAttempts(attempts),
            providerEvidence: attempts.length > 0 ? formatProviderEvidence(attempts) : undefined,
            payload: undefined
        };
    }
    catch (error) {
        return {
            exitCode: 1,
            raw: error instanceof Error ? error.message : String(error),
            payload: undefined
        };
    }
    finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}
export function normalizeAgent(value) {
    return normalizeAgents(value)[0];
}
export function normalizeAgents(value) {
    const requested = Array.isArray(value) ? value : splitAgentList(value);
    const normalized = unique(requested);
    return (normalized.length ? normalized : ["codex", "claude"]);
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
async function runAgentAttempt({ agent, provider, prompt, workspaceDir, model, env, tempDir }) {
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
            const healthResult = await runCommand(healthCheck.command, renderArgs(healthCheck.args, { prompt, workspaceDir, model, outputPath }), { cwd: workspaceDir, env, timeoutMs: healthCheck.timeoutMs });
            if (healthResult.exitCode !== 0) {
                const raw = `${healthResult.stdout}${healthResult.stderr}`;
                return {
                    agent,
                    exitCode: healthResult.exitCode,
                    failureClass: classifyFailure({ exitCode: healthResult.exitCode, raw }),
                    payloadSource: "none",
                    raw,
                    payload: undefined
                };
            }
        }
        const args = provider.createArgs({ prompt, workspaceDir, model, outputPath });
        const attemptEnv = agent === "codex" ? await withCodexCodeModeHost(env, provider.command) : env;
        const result = await runCommand(provider.command, args, { cwd: workspaceDir, env: attemptEnv, timeoutMs: provider.timeoutMs });
        const lastMessage = provider.output === "last-message" ? await readFile(outputPath, "utf8").catch(() => "") : "";
        const raw = `${result.stdout}${result.stderr}\n${lastMessage}`;
        const payloadSource = lastMessage ? "last-message" : "stdout";
        const parsedPayload = parseBuilderPayload(lastMessage || raw);
        const rawWithParseError = parsedPayload.error ? `${raw}\n${parsedPayload.error.message}` : raw;
        return {
            agent,
            exitCode: result.exitCode,
            failureClass: parsedPayload.payload ? undefined : classifyFailure({ exitCode: result.exitCode, raw: rawWithParseError }),
            payloadSource: parsedPayload.payload ? payloadSource : "none",
            raw: rawWithParseError,
            payload: parsedPayload.payload
        };
    }
    catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        return {
            agent,
            exitCode: 1,
            failureClass: classifyFailure({ exitCode: 1, raw, error }),
            payloadSource: "none",
            raw,
            payload: undefined
        };
    }
}
async function withCodexCodeModeHost(env, command) {
    if (env.CODEX_CODE_MODE_HOST_PATH && await isExecutableFile(env.CODEX_CODE_MODE_HOST_PATH))
        return env;
    const commandPath = await resolveCommand(command, env.PATH);
    const candidates = [];
    if (commandPath) {
        candidates.push(join(dirname(commandPath), "codex-code-mode-host"));
        const resolvedCommand = await realpath(commandPath).catch(() => undefined);
        if (resolvedCommand)
            candidates.push(join(dirname(resolvedCommand), "codex-code-mode-host"));
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
async function isExecutableFile(path) {
    return Promise.all([access(path, constants.X_OK), stat(path)])
        .then(([, metadata]) => metadata.isFile(), () => false);
}
async function resolveCommand(command, pathValue) {
    if (isAbsolute(command))
        return command;
    for (const directory of pathValue?.split(delimiter) ?? []) {
        if (!directory)
            continue;
        const candidate = join(directory, command);
        if (await access(candidate, constants.X_OK).then(() => true, () => false))
            return candidate;
    }
    return undefined;
}
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} workspaceDir
 */
async function loadAgentProviders(env, workspaceDir) {
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
async function readProviderFile(path, workspaceDir) {
    if (!path)
        return undefined;
    const resolved = isAbsolute(path) ? path : resolve(workspaceDir, path);
    return readFile(resolved, "utf8");
}
/**
 * @param {string | undefined} raw
 * @param {string} [source]
 * @returns {Record<string, { command: string, output: "stdout" | "last-message", fallbackOn: string[], timeoutMs?: number, healthCheck?: { command: string, args: string[], timeoutMs?: number }, createArgs(input: { prompt: string, workspaceDir: string, model?: string, outputPath: string }): string[] }>}
 */
function parseCustomProviders(raw, source = "KAIZEN_AGENT_PROVIDERS") {
    if (!raw)
        return {};
    const parsed = parseMaybeJson(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${source} must be a JSON object.`);
    }
    const providerMap = normalizeProviderMap(parsed, source);
    return Object.fromEntries(Object.entries(providerMap).map(([name, value]) => [name, createCustomProvider(name, value)]));
}
/**
 * @param {Record<string, unknown>} parsed
 * @param {string} source
 */
function normalizeProviderMap(parsed, source) {
    const providers = parsed.providers;
    if (providers !== undefined) {
        if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
            throw new Error(`${source} providers must be an object.`);
        }
        return providers;
    }
    return parsed;
}
/**
 * @param {string} name
 * @param {unknown} value
 */
function createCustomProvider(name, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Provider "${name}" must be an object.`);
    }
    const configRecord = value;
    assertKnownFields(configRecord, CUSTOM_PROVIDER_FIELDS, `Provider "${name}"`);
    const config = configRecord;
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
    const fallbackOn = normalizeFallbackOn(config.fallbackOn, name);
    const timeoutMs = normalizeTimeoutMs(config.timeoutMs, `Provider "${name}" timeoutMs`);
    return {
        command: config.command,
        output,
        fallbackOn,
        ...(timeoutMs ? { timeoutMs } : {}),
        ...createHealthCheck(config.healthCheck, config.command, name),
        createArgs: (input) => {
            const renderedPrompt = renderTemplate(promptTemplate, input);
            return renderArgs(args, { ...input, prompt: renderedPrompt });
        }
    };
}
function assertKnownFields(value, allowedFields, label) {
    const unsupportedFields = Object.keys(value).filter((key) => !allowedFields.has(key));
    if (unsupportedFields.length) {
        throw new Error(`${label} has unsupported field${unsupportedFields.length === 1 ? "" : "s"}: ${unsupportedFields.join(", ")}. Supported fields: ${[...allowedFields].join(", ")}.`);
    }
}
function normalizeProviderOutput(value, name) {
    if (value === undefined)
        return "stdout";
    if (value === "stdout" || value === "last-message")
        return value;
    throw new Error(`Provider "${name}" output must be "stdout" or "last-message".`);
}
/**
 * @param {unknown} value
 * @param {string} name
 */
function normalizeFallbackOn(value, name) {
    if (value === undefined)
        return DEFAULT_FALLBACK_ON;
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
function normalizeTimeoutMs(value, label) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return value;
}
function isAgentFailureClass(value) {
    return typeof value === "string" && FAILURE_CLASSES.has(value);
}
/**
 * @param {unknown} value
 * @param {string} providerCommand
 * @param {string} name
 */
function createHealthCheck(value, providerCommand, name) {
    if (value === undefined)
        return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Provider "${name}" healthCheck must be an object.`);
    }
    const healthCheckRecord = value;
    assertKnownFields(healthCheckRecord, HEALTH_CHECK_FIELDS, `Provider "${name}" healthCheck`);
    const healthCheck = healthCheckRecord;
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
    if (model)
        args.push("--model", model);
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
        "Bash(npm:*) Read Write Edit Glob Grep"
    ];
    if (model)
        args.push("--model", model);
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
    if (!value)
        return [];
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
/**
 * @param {AgentRunResult & { failureClass?: string }} attempt
 * @param {{ fallbackOn?: string[] } | undefined} provider
 */
function shouldFallback(attempt, provider) {
    if (attempt.payload)
        return false;
    const failureClass = attempt.failureClass ?? "invalid_payload";
    const fallbackOn = provider?.fallbackOn ?? DEFAULT_FALLBACK_ON;
    return fallbackOn.includes(failureClass);
}
/**
 * @param {string} value
 */
function sanitizeFilename(value) {
    return value.replace(/[^a-z0-9._-]/gi, "_");
}
/**
 * @param {AgentRunResult & { agent?: AgentKind, fallbackAllowed?: boolean, fallbackReason?: string }} attempt
 */
function formatAttempt(attempt) {
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
function formatAttempts(attempts) {
    return attempts.map(formatAttempt).join("\n\n");
}
/**
 * @param {KaizenLoopPayload} payload
 * @param {Array<AgentRunResult & { agent?: AgentKind, failureClass?: string, payloadSource?: string, fallbackAllowed?: boolean, fallbackReason?: string }>} attempts
 */
function appendProviderEvidence(payload, attempts) {
    const evidence = formatProviderEvidence(attempts);
    return {
        ...payload,
        notes: payload.notes ? `${payload.notes}\n\n${evidence}` : evidence
    };
}
function shouldAppendProviderEvidence(payload) {
    return payload.status === "fixed" || payload.status === "partial" || payload.status === "blocked";
}
/**
 * @param {Array<AgentRunResult & { agent?: AgentKind, failureClass?: string, payloadSource?: string, fallbackAllowed?: boolean, fallbackReason?: string }>} attempts
 */
function formatProviderEvidence(attempts) {
    const selected = attempts.find((attempt) => attempt.payload);
    const lines = attempts.map((attempt) => {
        const status = selected === attempt ? "selected" : attempt.fallbackAllowed ? "fallback" : "stopped";
        return `- ${attempt.agent ?? "unknown"}: exitCode=${attempt.exitCode}, status=${status}, failureClass=${attempt.failureClass ?? "none"}, fallbackReason=${attempt.fallbackReason ?? "none"}, payloadSource=${attempt.payloadSource ?? "none"}`;
    });
    return [
        "Provider evidence:",
        ...lines,
        ...(selected ? [`Selected backend: ${selected.agent ?? "unknown"}`, `Final payload source: ${selected.payloadSource ?? "unknown"}`] : [])
    ].join("\n");
}
/**
 * @param {{ exitCode: number, raw: string, error?: unknown }} input
 */
function classifyFailure({ exitCode, raw, error }) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const text = `${code}\n${raw}`.toLowerCase();
    if (text.includes("enoent") || text.includes("not found") || text.includes("command not found")) {
        return "command_missing";
    }
    if (text.includes("timed out") || text.includes("timeout")) {
        return "timeout";
    }
    if (/\b401\b/.test(text) || text.includes("unauthorized") || text.includes("unauthenticated") || text.includes("not authenticated") || text.includes("api key") || text.includes("login required")) {
        return "auth_failed";
    }
    if (/\b429\b/.test(text) || text.includes("rate limit") || text.includes("too many requests") || text.includes("quota exceeded")) {
        return "rate_limited";
    }
    if (text.includes("content policy") || text.includes("provider blocked") || text.includes("safety refusal") || text.includes("safety policy")) {
        return "provider_blocked";
    }
    return "invalid_payload";
}
/**
 * @param {string} raw
 * @returns {{ payload?: KaizenLoopPayload, error?: Error }}
 */
function parseBuilderPayload(raw) {
    const topLevel = parseMaybeJson(raw);
    const finalText = topLevel && typeof topLevel === "object" && "result" in topLevel
        ? String(topLevel.result)
        : raw;
    const payload = parseMaybeJson(extractLastJsonObject(finalText));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {};
    }
    try {
        return { payload: normalizeKaizenLoopPayload(payload) };
    }
    catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
    }
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
            if (settled)
                return;
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
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === "\"") {
                inString = false;
            }
            continue;
        }
        if (char === "\"") {
            inString = true;
        }
        else if (char === "{") {
            if (depth === 0)
                start = index;
            depth += 1;
        }
        else if (char === "}") {
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
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
