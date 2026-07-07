import type { BuildRequestInput, BuildResult, BuilderAdapter } from "../types/contracts.js";
export interface BuilderAgentOptions {
    workspaceDir?: string;
}
export declare class BuilderAgent {
    adapter: BuilderAdapter;
    workspaceDir: string;
    constructor(adapter: BuilderAdapter, options?: BuilderAgentOptions);
    build(input: BuildRequestInput): Promise<BuildResult>;
}
/**
 * @param {BuildRequestInput} request
 * @param {BuilderAdapter} adapter
 * @returns {Promise<BuildResult>}
 */
export declare function runBuild(request: BuildRequestInput, adapter: BuilderAdapter): Promise<BuildResult>;
//# sourceMappingURL=BuilderAgent.d.ts.map