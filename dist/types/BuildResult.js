import { createFailedReview, normalizeSelfReview } from "../review/SelfReview.js";
import { DEFAULT_THRESHOLD } from "./BuildRequest.js";
import { normalizeDiscoveredIssues as normalizeSharedDiscoveredIssues } from "./DiscoveredIssue.js";
const STATUS_VALUES = new Set(["ready", "blocked", "failed"]);
const BUILD_RESULT_KEYS = new Set([
    "status",
    "iterations",
    "taskUnderstanding",
    "planSummary",
    "changedFiles",
    "review",
    "residualNotes",
    "discoveredIssues"
]);
export function createBuildResult(input) {
    const { status, iterations, taskUnderstanding, planSummary, changedFiles, review, residualNotes, discoveredIssues, threshold } = input;
    if (!STATUS_VALUES.has(status)) {
        throw new Error(`Invalid build result status: ${status}`);
    }
    if (!Number.isInteger(iterations) || iterations < 0) {
        throw new Error("Build result iterations must be a non-negative integer.");
    }
    if (typeof planSummary !== "string" || planSummary.trim().length === 0) {
        throw new Error("Build result planSummary must be a non-empty string.");
    }
    return {
        status,
        iterations,
        taskUnderstanding: normalizeTaskUnderstanding(taskUnderstanding),
        planSummary: planSummary.trim(),
        changedFiles: uniqueStrings(changedFiles, "changedFiles"),
        review: normalizeSelfReview(review, threshold),
        residualNotes: uniqueStrings(residualNotes, "residualNotes"),
        discoveredIssues: normalizeDiscoveredIssues(discoveredIssues)
    };
}
export function normalizeBuildResult(input, threshold = DEFAULT_THRESHOLD) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Build result must be an object.");
    }
    assertAllowedKeys(input, BUILD_RESULT_KEYS, "Build result");
    return createBuildResult({ ...input, threshold });
}
export function createFailedBuildResult(message) {
    return {
        status: "failed",
        iterations: 0,
        taskUnderstanding: {
            summary: "Builder Agent could not complete task analysis.",
            constraints: []
        },
        planSummary: "Builder Agent could not complete the build loop.",
        changedFiles: [],
        review: createFailedReview(message),
        residualNotes: [message],
        discoveredIssues: []
    };
}
export function uniqueStrings(value, label) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
        throw new Error(`Build result ${label} must be an array of non-empty strings.`);
    }
    return [...new Set(value.map((item) => item.trim()))];
}
/**
 * @param {unknown} value
 * @returns {import("./contracts.js").TaskUnderstanding}
 */
export function normalizeTaskUnderstanding(value) {
    if (value === undefined) {
        return {
            summary: "Task understanding was not recorded by this build result.",
            constraints: []
        };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Build result taskUnderstanding must be an object.");
    }
    assertAllowedKeys(value, new Set(["summary", "goal", "constraints"]), "Build result taskUnderstanding");
    if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
        throw new Error("Build result taskUnderstanding.summary must be a non-empty string.");
    }
    if (!Object.hasOwn(value, "constraints")) {
        throw new Error("Build result taskUnderstanding.constraints is required.");
    }
    /** @type {import("./contracts.js").TaskUnderstanding} */
    const result = {
        summary: value.summary.trim(),
        constraints: uniqueStrings(value.constraints, "taskUnderstanding.constraints")
    };
    if (value.goal !== undefined) {
        if (typeof value.goal !== "string" || value.goal.trim().length === 0) {
            throw new Error("Build result taskUnderstanding.goal must be a non-empty string.");
        }
        result.goal = value.goal.trim();
    }
    return result;
}
function assertAllowedKeys(input, allowedKeys, label) {
    const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
    }
}
export function normalizeDiscoveredIssues(value) {
    return normalizeSharedDiscoveredIssues(value, { label: "Build result discoveredIssues" });
}
