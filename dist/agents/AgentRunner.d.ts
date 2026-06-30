import type { AgentKind, AgentRunInput, AgentRunResult } from "../types/contracts.js";
export declare function runImplementationAgent({ agent, prompt, workspaceDir, model, env }: AgentRunInput): Promise<AgentRunResult>;
export declare function normalizeAgent(value: string | undefined): AgentKind;
export declare function normalizeAgents(value: string | string[] | undefined): AgentKind[];
//# sourceMappingURL=AgentRunner.d.ts.map