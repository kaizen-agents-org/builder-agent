/** @import { AgentRunResult, KaizenLoopBuilderIO, KaizenLoopPayload } from "./types/contracts.js" */
/**
 * @param {KaizenLoopBuilderIO} input
 * @returns {Promise<KaizenLoopPayload>}
 */
export function runKaizenLoopBuilder({ stdin, stdout, stderr, env }: KaizenLoopBuilderIO): Promise<KaizenLoopPayload>;
import type { KaizenLoopBuilderIO } from "./types/contracts.js";
import type { KaizenLoopPayload } from "./types/contracts.js";
//# sourceMappingURL=kaizen-loop.d.ts.map