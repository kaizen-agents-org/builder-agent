/** @typedef {import("./types/contracts.js").AgentKind} AgentKind */
/** @typedef {import("./types/contracts.js").AgentRunInput} AgentRunInput */
/** @typedef {import("./types/contracts.js").AgentRunResult} AgentRunResult */
/** @typedef {import("./types/contracts.js").BuildArtifactPaths} BuildArtifactPaths */
/** @typedef {import("./types/contracts.js").BuildRequest} BuildRequest */
/** @typedef {import("./types/contracts.js").BuildRequestInput} BuildRequestInput */
/** @typedef {import("./types/contracts.js").BuildResult} BuildResult */
/** @typedef {import("./types/contracts.js").BuilderAdapter} BuilderAdapter */
/** @typedef {import("./types/contracts.js").DiscoveredIssue} DiscoveredIssue */
/** @typedef {import("./types/contracts.js").KaizenLoopPayload} KaizenLoopPayload */
/** @typedef {import("./types/contracts.js").SelfReviewResult} SelfReviewResult */

export { BuilderAgent, runBuild } from "./builder/BuilderAgent.js";
export { normalizeAgent, normalizeAgents, runImplementationAgent } from "./agents/AgentRunner.js";
export { normalizeBuildRequest, DEFAULT_MAX_ITERATIONS, DEFAULT_THRESHOLD } from "./types/BuildRequest.js";
export { createBuildResult, createFailedBuildResult, normalizeBuildResult } from "./types/BuildResult.js";
export { normalizeKaizenLoopPayload } from "./types/KaizenLoopPayload.js";
export { DIMENSION_KEYS, isReviewPassed, normalizeSelfReview } from "./review/SelfReview.js";
