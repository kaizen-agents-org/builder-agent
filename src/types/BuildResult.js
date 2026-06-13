import { createFailedReview, normalizeSelfReview } from "../review/SelfReview.js";
import { DEFAULT_THRESHOLD } from "./BuildRequest.js";

const STATUS_VALUES = new Set(["ready", "blocked", "failed"]);
const BUILD_RESULT_KEYS = new Set([
  "status",
  "iterations",
  "planSummary",
  "changedFiles",
  "review",
  "residualNotes",
  "discoveredIssues"
]);

export function createBuildResult(input) {
  const {
    status,
    iterations,
    planSummary,
    changedFiles,
    review,
    residualNotes,
    discoveredIssues,
    threshold
  } = input;

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

function assertAllowedKeys(input, allowedKeys, label) {
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));

  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
  }
}

export function normalizeDiscoveredIssues(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Build result discoveredIssues must be an array.");
  }

  return value.map((item, index) => normalizeDiscoveredIssue(item, index));
}

function normalizeDiscoveredIssue(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`Build result discoveredIssues[${index}] must be an object.`);
  }

  assertAllowedKeys(
    item,
    new Set(["title", "body", "expected", "evidence", "repo", "severity", "labels"]),
    `Build result discoveredIssues[${index}]`
  );

  if (typeof item.title !== "string" || item.title.trim().length === 0) {
    throw new Error(`Build result discoveredIssues[${index}].title must be a non-empty string.`);
  }

  return {
    title: item.title.trim(),
    ...(typeof item.body === "string" && item.body.trim() ? { body: item.body.trim() } : {}),
    ...(typeof item.expected === "string" && item.expected.trim() ? { expected: item.expected.trim() } : {}),
    ...(typeof item.evidence === "string" && item.evidence.trim() ? { evidence: item.evidence.trim() } : {}),
    ...(typeof item.repo === "string" && item.repo.trim() ? { repo: item.repo.trim() } : {}),
    ...(typeof item.severity === "string" && item.severity.trim() ? { severity: item.severity.trim() } : {}),
    ...(Array.isArray(item.labels) ? { labels: uniqueStrings(item.labels, `discoveredIssues[${index}].labels`) } : {})
  };
}
