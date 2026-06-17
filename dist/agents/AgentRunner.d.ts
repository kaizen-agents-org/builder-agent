/**
 * @param {AgentRunInput} input
 * @returns {Promise<AgentRunResult>}
 */
export function runImplementationAgent({ agent, prompt, workspaceDir, model, env }: AgentRunInput): Promise<AgentRunResult>;
/**
 * @param {string | undefined} value
 * @returns {AgentKind}
 */
export function normalizeAgent(value: string | undefined): AgentKind;
/**
 * @param {string | string[] | undefined} value
 * @returns {AgentKind[]}
 */
export function normalizeAgents(value: string | string[] | undefined): AgentKind[];
import type { AgentRunInput } from "../types/contracts.js";
import type { AgentRunResult } from "../types/contracts.js";
import type { AgentKind } from "../types/contracts.js";
//# sourceMappingURL=AgentRunner.d.ts.map