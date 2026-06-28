import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeAgents, runImplementationAgent } from "./agents/AgentRunner.js";
import { normalizeKaizenLoopPayload } from "./types/KaizenLoopPayload.js";

/** @import { AgentRunResult, KaizenLoopBuilderIO, KaizenLoopPayload } from "./types/contracts.js" */

/**
 * @param {KaizenLoopBuilderIO} input
 * @returns {Promise<KaizenLoopPayload>}
 */
export async function runKaizenLoopBuilder({ stdin, stdout, stderr, env }) {
  const prompt = await readStream(stdin);
  const workspaceDir = env.KAIZEN_WORKSPACE_DIR || process.cwd();
  const preferredAgents = normalizeAgents(env.KAIZEN_PREFERRED_AGENT);
  const model = env.KAIZEN_AGENT_MODEL || undefined;
  const resultPath = env.KAIZEN_BUILD_RESULT_PATH;

  if (!resultPath) {
    throw new Error("KAIZEN_BUILD_RESULT_PATH is required for Kaizen Loop integration.");
  }

  const result = await runImplementationAgent({
    agent: preferredAgents,
    prompt,
    workspaceDir,
    model,
    env
  });
  const payload = normalizeKaizenLoopPayload(result.payload ?? blockedPayload(result));

  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  if (!result.payload && result.raw.trim()) {
    stderr.write(tail(result.raw, 4000));
  }

  return payload;
}

/**
 * @param {AgentRunResult} result
 * @returns {KaizenLoopPayload}
 */
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

/**
 * @param {AsyncIterable<Buffer | string>} stream
 */
async function readStream(stream) {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}

/**
 * @param {string} text
 * @param {number} maxLength
 */
function tail(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}
