export type BuildStatus = "current" | "stale" | "unknown";
export interface GeneratedBuildInfo {
    version: string;
    sourceCommit: string;
    sourceHash: string;
}
export interface CliBuildInfo extends GeneratedBuildInfo {
    name: "builder-agent";
    status: BuildStatus;
}
export declare function createBuildInfo(root?: string): Promise<GeneratedBuildInfo>;
export declare function readCliBuildInfo(root?: string): Promise<CliBuildInfo>;
//# sourceMappingURL=build-info.d.ts.map