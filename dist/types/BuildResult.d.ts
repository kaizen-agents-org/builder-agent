export function createBuildResult(input: any): {
    status: any;
    iterations: any;
    taskUnderstanding: import("./contracts.js").TaskUnderstanding;
    planSummary: string;
    changedFiles: any[];
    review: {
        score: any;
        confidence: number;
        dimensions: {
            [k: string]: any;
        };
        mustFix: any[];
        shouldFix: any[];
        niceToHave: any[];
        improvementInstructions: any[];
        passed: boolean;
    };
    residualNotes: any[];
    discoveredIssues: import("./contracts.js").DiscoveredIssue[];
};
export function normalizeBuildResult(input: any, threshold?: number): {
    status: any;
    iterations: any;
    taskUnderstanding: import("./contracts.js").TaskUnderstanding;
    planSummary: string;
    changedFiles: any[];
    review: {
        score: any;
        confidence: number;
        dimensions: {
            [k: string]: any;
        };
        mustFix: any[];
        shouldFix: any[];
        niceToHave: any[];
        improvementInstructions: any[];
        passed: boolean;
    };
    residualNotes: any[];
    discoveredIssues: import("./contracts.js").DiscoveredIssue[];
};
export function createFailedBuildResult(message: any): {
    status: string;
    iterations: number;
    taskUnderstanding: {
        summary: string;
        constraints: never[];
    };
    planSummary: string;
    changedFiles: never[];
    review: {
        score: number;
        confidence: number;
        dimensions: {
            [k: string]: number;
        };
        mustFix: any[];
        shouldFix: never[];
        niceToHave: never[];
        improvementInstructions: never[];
        passed: boolean;
    };
    residualNotes: any[];
    discoveredIssues: never[];
};
export function uniqueStrings(value: any, label: any): any[];
/**
 * @param {unknown} value
 * @returns {import("./contracts.js").TaskUnderstanding}
 */
export function normalizeTaskUnderstanding(value: unknown): import("./contracts.js").TaskUnderstanding;
export function normalizeDiscoveredIssues(value: any): import("./contracts.js").DiscoveredIssue[];
//# sourceMappingURL=BuildResult.d.ts.map