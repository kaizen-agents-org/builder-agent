import type { BuildResult, BuildResultInput, DiscoveredIssue, TaskUnderstanding } from "./contracts.js";
export declare function createBuildResult(input: BuildResultInput): BuildResult;
export declare function normalizeBuildResult(input: unknown, threshold?: number): BuildResult;
export declare function createFailedBuildResult(message: string): BuildResult;
export declare function uniqueStrings(value: unknown, label: string): string[];
export declare function normalizeTaskUnderstanding(value: unknown): TaskUnderstanding;
export declare function normalizeDiscoveredIssues(value: unknown): DiscoveredIssue[];
//# sourceMappingURL=BuildResult.d.ts.map