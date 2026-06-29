import { normalizeSelfReview } from "../review/SelfReview.js";
import { normalizeBuildRequest } from "../types/BuildRequest.js";
import { createBuildResult, createFailedBuildResult, normalizeDiscoveredIssues, uniqueStrings } from "../types/BuildResult.js";
/** @import { BuildRequestInput, BuildResult, BuilderAdapter, DiscoveredIssue, ImplementationOutput, IterationArtifact, PlanOutput, SelfReviewResult } from "../types/contracts.js" */
const REQUIRED_ADAPTER_METHODS = ["analyzeTask", "createPlan", "implement", "selfReview", "improve"];
const ITERATION_ARTIFACTS_PROPERTY = "iterationArtifacts";
export class BuilderAgent {
    /**
     * @param {BuilderAdapter} adapter
     */
    constructor(adapter) {
        /** @type {BuilderAdapter} */
        this.adapter = adapter;
    }
    /**
     * @param {BuildRequestInput} input
     * @returns {Promise<BuildResult>}
     */
    async build(input) {
        /** @type {IterationArtifact[]} */
        const iterationArtifacts = [];
        let request;
        try {
            request = normalizeBuildRequest(input);
            assertAdapter(this.adapter);
            const analysis = await this.adapter.analyzeTask({ request });
            const taskUnderstanding = createTaskUnderstanding({ request, analysis });
            const plan = await this.adapter.createPlan({ request, analysis });
            const planSummary = summarizePlan(plan);
            let implementation = await this.adapter.implement({
                request,
                analysis,
                plan,
                iteration: 1
            });
            let changedFiles = extractChangedFiles(implementation);
            let discoveredIssues = extractDiscoveredIssues(implementation);
            let latestReview;
            for (let iteration = 1; iteration <= request.maxIterations; iteration += 1) {
                latestReview = normalizeSelfReview(await this.adapter.selfReview({
                    request,
                    analysis,
                    plan,
                    implementation,
                    iteration,
                    threshold: request.threshold
                }), request.threshold);
                const improvementInstructions = improvementInstructionsFor(latestReview);
                iterationArtifacts.push(createIterationArtifact({ iteration, implementation, review: latestReview, improvementInstructions }));
                if (latestReview.passed) {
                    return attachIterationArtifacts(createBuildResult({
                        status: "ready",
                        iterations: iteration,
                        taskUnderstanding,
                        planSummary,
                        changedFiles,
                        review: latestReview,
                        residualNotes: extractResidualNotes(implementation),
                        discoveredIssues,
                        threshold: request.threshold
                    }), iterationArtifacts);
                }
                if (iteration === request.maxIterations) {
                    return attachIterationArtifacts(createBuildResult({
                        status: "blocked",
                        iterations: iteration,
                        taskUnderstanding,
                        planSummary,
                        changedFiles,
                        review: latestReview,
                        residualNotes: [
                            `Self-review did not pass within ${request.maxIterations} iteration(s).`,
                            ...extractResidualNotes(implementation)
                        ],
                        discoveredIssues,
                        threshold: request.threshold
                    }), iterationArtifacts);
                }
                implementation = await this.adapter.improve({
                    request,
                    analysis,
                    plan,
                    implementation,
                    review: latestReview,
                    instructions: improvementInstructions,
                    iteration: iteration + 1
                });
                changedFiles = uniqueStrings([...changedFiles, ...extractChangedFiles(implementation)], "changedFiles");
                discoveredIssues = dedupeDiscoveredIssues([...discoveredIssues, ...extractDiscoveredIssues(implementation)]);
            }
            return attachIterationArtifacts(createBuildResult({
                status: "blocked",
                iterations: request.maxIterations,
                taskUnderstanding,
                planSummary,
                changedFiles,
                review: latestReview,
                residualNotes: ["Builder loop ended without a passing self-review."],
                discoveredIssues,
                threshold: request.threshold
            }), iterationArtifacts);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return attachIterationArtifacts(createFailedBuildResult(message), iterationArtifacts);
        }
    }
}
/**
 * @param {BuildRequestInput} request
 * @param {BuilderAdapter} adapter
 * @returns {Promise<BuildResult>}
 */
export async function runBuild(request, adapter) {
    return new BuilderAgent(adapter).build(request);
}
/**
 * @param {unknown} adapter
 */
function assertAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") {
        throw new Error("Builder Agent requires an adapter object.");
    }
    const missing = REQUIRED_ADAPTER_METHODS.filter((method) => typeof adapter[method] !== "function");
    if (missing.length > 0) {
        throw new Error(`Builder Agent adapter is missing required method(s): ${missing.join(", ")}.`);
    }
}
/**
 * @param {PlanOutput} plan
 */
function summarizePlan(plan) {
    if (typeof plan === "string" && plan.trim().length > 0) {
        return plan;
    }
    if (plan && typeof plan.summary === "string" && plan.summary.trim().length > 0) {
        return plan.summary;
    }
    return "Builder Agent executed the adapter-provided implementation plan.";
}
/**
 * @param {{ request: import("../types/contracts.js").BuildRequest, analysis: unknown }} input
 * @returns {import("../types/contracts.js").TaskUnderstanding}
 */
function createTaskUnderstanding({ request, analysis }) {
    const summary = summarizeAnalysis(analysis) ?? `Task: ${request.task}`;
    /** @type {import("../types/contracts.js").TaskUnderstanding} */
    const result = {
        summary,
        constraints: [...request.constraints]
    };
    if (request.goal) {
        result.goal = request.goal;
    }
    return result;
}
/**
 * @param {unknown} analysis
 * @returns {string | undefined}
 */
function summarizeAnalysis(analysis) {
    if (typeof analysis === "string" && analysis.trim().length > 0) {
        return analysis.trim();
    }
    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
        return undefined;
    }
    if (typeof analysis.taskUnderstanding === "string" && analysis.taskUnderstanding.trim().length > 0) {
        return analysis.taskUnderstanding.trim();
    }
    if (analysis.taskUnderstanding && typeof analysis.taskUnderstanding === "object" && !Array.isArray(analysis.taskUnderstanding)) {
        const nestedSummary = analysis.taskUnderstanding.summary;
        if (typeof nestedSummary === "string" && nestedSummary.trim().length > 0) {
            return nestedSummary.trim();
        }
    }
    if (typeof analysis.summary === "string" && analysis.summary.trim().length > 0) {
        return analysis.summary.trim();
    }
    return undefined;
}
/**
 * @param {ImplementationOutput} implementation
 */
function extractChangedFiles(implementation) {
    if (!implementation || implementation.changedFiles === undefined) {
        return [];
    }
    return uniqueStrings(implementation.changedFiles, "changedFiles");
}
/**
 * @param {ImplementationOutput} implementation
 */
function extractResidualNotes(implementation) {
    if (!implementation || implementation.residualNotes === undefined) {
        return [];
    }
    return uniqueStrings(implementation.residualNotes, "residualNotes");
}
/**
 * @param {ImplementationOutput} implementation
 */
function summarizeImplementation(implementation) {
    if (typeof implementation === "string" && implementation.trim().length > 0) {
        return implementation.trim();
    }
    if (implementation && typeof implementation.summary === "string" && implementation.summary.trim().length > 0) {
        return implementation.summary.trim();
    }
    const changedFiles = extractChangedFiles(implementation);
    if (changedFiles.length > 0) {
        return `Changed files: ${changedFiles.join(", ")}`;
    }
    return "Adapter did not provide an implementation summary.";
}
/**
 * @param {ImplementationOutput} implementation
 */
function extractDiscoveredIssues(implementation) {
    if (!implementation || implementation.discoveredIssues === undefined) {
        return [];
    }
    return normalizeDiscoveredIssues(implementation.discoveredIssues);
}
/**
 * @param {DiscoveredIssue[]} issues
 */
function dedupeDiscoveredIssues(issues) {
    const seen = new Set();
    /** @type {DiscoveredIssue[]} */
    const result = [];
    for (const issue of issues) {
        const key = JSON.stringify([issue.repo || "", issue.title]);
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(issue);
    }
    return result;
}
/**
 * @param {SelfReviewResult} review
 */
function improvementInstructionsFor(review) {
    if (review.improvementInstructions.length > 0) {
        return review.improvementInstructions;
    }
    return [...review.mustFix, ...review.shouldFix];
}
/**
 * @param {{ iteration: number, implementation: ImplementationOutput, review: SelfReviewResult, improvementInstructions: string[] }} input
 * @returns {IterationArtifact}
 */
function createIterationArtifact({ iteration, implementation, review, improvementInstructions }) {
    return {
        iteration,
        implementationSummary: summarizeImplementation(implementation),
        review: cloneJsonValue(review),
        improvementInstructions: cloneJsonValue(improvementInstructions),
        residualNotes: extractResidualNotes(implementation)
    };
}
/**
 * @param {BuildResult} result
 * @param {IterationArtifact[]} iterationArtifacts
 * @returns {BuildResult}
 */
function attachIterationArtifacts(result, iterationArtifacts) {
    Object.defineProperty(result, ITERATION_ARTIFACTS_PROPERTY, {
        value: iterationArtifacts,
        enumerable: false
    });
    return result;
}
/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneJsonValue(value) {
    return JSON.parse(JSON.stringify(value));
}
