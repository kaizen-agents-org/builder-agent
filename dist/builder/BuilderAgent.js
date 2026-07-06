import { normalizeSelfReview } from "../review/SelfReview.js";
import { normalizeBuildRequest } from "../types/BuildRequest.js";
import { createBuildResult, createFailedBuildResult, normalizeDiscoveredIssues, uniqueStrings } from "../types/BuildResult.js";
const REQUIRED_ADAPTER_METHODS = ["analyzeTask", "createPlan", "implement", "selfReview", "improve"];
const ITERATION_ARTIFACTS_PROPERTY = "iterationArtifacts";
export class BuilderAgent {
    adapter;
    constructor(adapter) {
        this.adapter = adapter;
    }
    async build(input) {
        const iterationArtifacts = [];
        let request;
        let taskUnderstanding;
        let planSummary;
        let changedFiles = [];
        let discoveredIssues = [];
        let residualNotes = [];
        try {
            request = normalizeBuildRequest(input);
            assertAdapter(this.adapter);
            const analysis = await this.adapter.analyzeTask({ request });
            taskUnderstanding = createTaskUnderstanding({ request, analysis });
            const plan = await this.adapter.createPlan({ request, analysis });
            planSummary = summarizePlan(plan);
            let implementation = await this.adapter.implement({
                request,
                analysis,
                plan,
                iteration: 1
            });
            changedFiles = extractChangedFiles(implementation);
            discoveredIssues = extractDiscoveredIssues(implementation);
            residualNotes = extractResidualNotes(implementation);
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
                        residualNotes,
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
                            ...residualNotes
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
                residualNotes = uniqueStrings([...residualNotes, ...extractResidualNotes(implementation)], "residualNotes");
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
            const fallback = createFailedBuildResult(message);
            return attachIterationArtifacts(createBuildResult({
                status: "failed",
                iterations: iterationArtifacts.length,
                taskUnderstanding: taskUnderstanding ?? fallback.taskUnderstanding,
                planSummary: planSummary ?? fallback.planSummary,
                changedFiles,
                review: fallback.review,
                residualNotes: uniqueStrings([...residualNotes, message], "residualNotes"),
                discoveredIssues,
                threshold: request?.threshold
            }), iterationArtifacts);
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
function assertAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") {
        throw new Error("Builder Agent requires an adapter object.");
    }
    const candidate = adapter;
    const missing = REQUIRED_ADAPTER_METHODS.filter((method) => typeof candidate[method] !== "function");
    if (missing.length > 0) {
        throw new Error(`Builder Agent adapter is missing required method(s): ${missing.join(", ")}.`);
    }
}
function summarizePlan(plan) {
    if (typeof plan === "string" && plan.trim().length > 0) {
        return plan;
    }
    if (typeof plan === "object" && plan && typeof plan.summary === "string" && plan.summary.trim().length > 0) {
        return plan.summary;
    }
    return "Builder Agent executed the adapter-provided implementation plan.";
}
function createTaskUnderstanding({ request, analysis }) {
    const summary = summarizeAnalysis(analysis) ?? `Task: ${request.task}`;
    const result = {
        summary,
        constraints: [...request.constraints]
    };
    if (request.goal) {
        result.goal = request.goal;
    }
    return result;
}
function summarizeAnalysis(analysis) {
    if (typeof analysis === "string" && analysis.trim().length > 0) {
        return analysis.trim();
    }
    if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
        return undefined;
    }
    const input = analysis;
    if (typeof input.taskUnderstanding === "string" && input.taskUnderstanding.trim().length > 0) {
        return input.taskUnderstanding.trim();
    }
    if (input.taskUnderstanding && typeof input.taskUnderstanding === "object" && !Array.isArray(input.taskUnderstanding)) {
        const nestedSummary = input.taskUnderstanding.summary;
        if (typeof nestedSummary === "string" && nestedSummary.trim().length > 0) {
            return nestedSummary.trim();
        }
    }
    if (typeof input.summary === "string" && input.summary.trim().length > 0) {
        return input.summary.trim();
    }
    return undefined;
}
function extractChangedFiles(implementation) {
    if (!implementation || typeof implementation === "string" || implementation.changedFiles === undefined) {
        return [];
    }
    return uniqueStrings(implementation.changedFiles, "changedFiles");
}
function extractResidualNotes(implementation) {
    if (!implementation || typeof implementation === "string" || implementation.residualNotes === undefined) {
        return [];
    }
    return uniqueStrings(implementation.residualNotes, "residualNotes");
}
function summarizeImplementation(implementation) {
    if (typeof implementation === "string" && implementation.trim().length > 0) {
        return implementation.trim();
    }
    if (implementation && typeof implementation !== "string" && typeof implementation.summary === "string" && implementation.summary.trim().length > 0) {
        return implementation.summary.trim();
    }
    const changedFiles = extractChangedFiles(implementation);
    if (changedFiles.length > 0) {
        return `Changed files: ${changedFiles.join(", ")}`;
    }
    return "Adapter did not provide an implementation summary.";
}
function extractDiscoveredIssues(implementation) {
    if (!implementation || typeof implementation === "string" || implementation.discoveredIssues === undefined) {
        return [];
    }
    return normalizeDiscoveredIssues(implementation.discoveredIssues);
}
function dedupeDiscoveredIssues(issues) {
    const seen = new Set();
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
function improvementInstructionsFor(review) {
    if (review.improvementInstructions.length > 0) {
        return review.improvementInstructions;
    }
    return [...review.mustFix, ...review.shouldFix];
}
function createIterationArtifact({ iteration, implementation, review, improvementInstructions }) {
    return {
        iteration,
        implementationSummary: summarizeImplementation(implementation),
        changedFiles: extractChangedFiles(implementation),
        discoveredIssues: extractDiscoveredIssues(implementation),
        review: cloneJsonValue(review),
        improvementInstructions: cloneJsonValue(improvementInstructions),
        residualNotes: extractResidualNotes(implementation)
    };
}
function attachIterationArtifacts(result, iterationArtifacts) {
    Object.defineProperty(result, ITERATION_ARTIFACTS_PROPERTY, {
        value: iterationArtifacts,
        enumerable: false
    });
    return result;
}
function cloneJsonValue(value) {
    return JSON.parse(JSON.stringify(value));
}
