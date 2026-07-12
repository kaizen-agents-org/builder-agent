import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeAgents, runImplementationAgent } from "./agents/AgentRunner.js";
import { normalizeKaizenLoopPayload } from "./types/KaizenLoopPayload.js";
import type { AgentRunResult, KaizenLoopBuilderIO, KaizenLoopPayload } from "./types/contracts.js";

export async function runKaizenLoopBuilder({ stdin, stdout, stderr, env }: KaizenLoopBuilderIO): Promise<KaizenLoopPayload> {
  const prompt = await readStream(stdin);
  const workspaceDir = env.KAIZEN_WORKSPACE_DIR || process.cwd();
  const preferredAgents = normalizeAgents(env.KAIZEN_PREFERRED_AGENT);
  const model = env.KAIZEN_AGENT_MODEL || undefined;
  const configuredResultPath = env.KAIZEN_BUILD_RESULT_PATH;

  if (!configuredResultPath) {
    throw new Error("KAIZEN_BUILD_RESULT_PATH is required for Kaizen Loop integration.");
  }

  const resultPath = resolve(workspaceDir, configuredResultPath);

  const result = await runImplementationAgent({
    agent: preferredAgents,
    prompt,
    workspaceDir,
    model,
    env
  });
  const payload = safeNormalizePayload(result.payload ?? blockedPayload(result));

  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  if (!result.payload && result.raw.trim()) {
    stderr.write(tail(result.raw, 4000));
  }

  return payload;
}

function safeNormalizePayload(payload: unknown): KaizenLoopPayload {
  try {
    return normalizeKaizenLoopPayload(payload);
  } catch (error) {
    const reason = "Builder agent returned an invalid Kaizen Loop payload.";
    return normalizeKaizenLoopPayload({
      status: "blocked",
      summary: reason,
      notes: error instanceof Error ? error.message : String(error),
      blockedReason: reason,
      discoveredIssues: []
    });
  }
}

function blockedPayload(result: AgentRunResult): KaizenLoopPayload {
  const reason =
    result.exitCode === 0
      ? "Builder agent did not return the required Kaizen Loop JSON payload."
      : `Builder agent exited with code ${result.exitCode}.`;

  return {
    status: "blocked",
    summary: reason,
    notes: blockedNotes(result),
    blockedReason: reason,
    discoveredIssues: []
  };
}

function blockedNotes(result: AgentRunResult): string {
  const rawTail = tail(result.raw, 2000);
  if (!result.providerEvidence) return rawTail;
  return rawTail ? `${result.providerEvidence}\n\nRaw output tail:\n${rawTail}` : result.providerEvidence;
}

async function readStream(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}

function tail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}
