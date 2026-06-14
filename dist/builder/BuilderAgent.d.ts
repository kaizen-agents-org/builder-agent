/**
 * @param {BuildRequestInput} request
 * @param {BuilderAdapter} adapter
 * @returns {Promise<BuildResult>}
 */
export function runBuild(request: BuildRequestInput, adapter: BuilderAdapter): Promise<BuildResult>;
export class BuilderAgent {
    /**
     * @param {BuilderAdapter} adapter
     */
    constructor(adapter: BuilderAdapter);
    /** @type {BuilderAdapter} */
    adapter: BuilderAdapter;
    /**
     * @param {BuildRequestInput} input
     * @returns {Promise<BuildResult>}
     */
    build(input: BuildRequestInput): Promise<BuildResult>;
}
import type { BuildRequestInput } from "../types/contracts.js";
import type { BuilderAdapter } from "../types/contracts.js";
import type { BuildResult } from "../types/contracts.js";
//# sourceMappingURL=BuilderAgent.d.ts.map