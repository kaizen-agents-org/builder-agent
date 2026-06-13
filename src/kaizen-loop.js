import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PAYLOAD_STATUSES = new Set(["fixed", "partial", "blocked"]);

export async function runKaizenLoopBuilder({ stdin, stdout, stderr, env }) {
  const prompt = await readStream(stdin);
  const workspaceDir = env.KAIZEN_WORKSPACE_DIR || process.cwd();
  const preferredAgent = normalizeAgent(env.KAIZEN_PREFERRED_AGENT);
  const model = env.KAIZEN_AGENT_MODEL || undefined;
  const resultPath = env.KAIZEN_BUILD_RESULT_PATH;

  if (!resultPath) {
    throw new Error("KAIZEN_BUILD_RESULT_PATH is required for Kaizen Loop integration.");
  }

  const result = await runImplementationAgent({
    agent: preferredAgent,
    prompt,
    workspaceDir,
    model,
    env
  });
  const payload = result.payload ?? blockedPayload(result);

  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  if (!result.payload && result.raw.trim()) {
    stderr.write(tail(result.raw, 4000));
  }

  return payload;
}

async function runImplementationAgent({ agent, prompt, workspaceDir, model, env }) {
  const tempDir = await mkdtemp(join(tmpdir(), "builder-agent-"));

  try {
    const outputPath = join(tempDir, "last-message.txt");
    const command = agent === "codex" ? "codex" : "claude";
    const args =
      agent === "codex"
        ? codexArgs({ prompt, workspaceDir, model, outputPath })
        : claudeArgs({ prompt, model });

    const result = await runCommand(command, args, { cwd: workspaceDir, env });
    const lastMessage = agent === "codex" ? await readFile(outputPath, "utf8").catch(() => "") : "";
    const raw = `${result.stdout}${result.stderr}\n${lastMessage}`;
    const payload = result.exitCode === 0 ? parseBuilderPayload(lastMessage || raw) : undefined;

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

function normalizeAgent(value) {
  return value === "codex" ? "codex" : "claude";
}

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

function blockedPayload(result) {
  const reason =
    result.exitCode === 0
      ? "Builder agent did not return the required Kaizen Loop JSON payload."
      : `Builder agent exited with code ${result.exitCode}.`;

  return {
    status: "blocked",
    summary: reason,
    notes: tail(result.raw, 2000),
    blockedReason: reason,
    discoveredIssues: []
  };
}

function normalizeDiscoveredIssues(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => normalizeDiscoveredIssue(item))
    .filter(Boolean);
}

function normalizeDiscoveredIssue(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  if (typeof item.title !== "string" || item.title.trim().length === 0) return undefined;

  return {
    title: item.title.trim(),
    ...(typeof item.body === "string" && item.body.trim() ? { body: item.body.trim() } : {}),
    ...(typeof item.expected === "string" && item.expected.trim() ? { expected: item.expected.trim() } : {}),
    ...(typeof item.evidence === "string" && item.evidence.trim() ? { evidence: item.evidence.trim() } : {}),
    ...(typeof item.repo === "string" && item.repo.trim() ? { repo: item.repo.trim() } : {}),
    ...(typeof item.severity === "string" && item.severity.trim() ? { severity: item.severity.trim() } : {}),
    ...(Array.isArray(item.labels) ? { labels: uniqueStrings(item.labels) } : {})
  };
}

function uniqueStrings(value) {
  return [
    ...new Set(value.flatMap((item) => {
      if (typeof item !== "string") return [];
      const trimmed = item.trim();
      return trimmed ? [trimmed] : [];
    }))
  ];
}

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

async function readStream(stream) {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}

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

function parseMaybeJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function tail(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}
