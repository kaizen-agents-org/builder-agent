import { createFailedReview, normalizeSelfReview } from "../review/SelfReview.js";

const STATUS_VALUES = new Set(["ready", "blocked", "failed"]);

export function createBuildResult({
  status,
  iterations,
  planSummary,
  changedFiles,
  review,
  residualNotes,
  threshold
}) {
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
    residualNotes: uniqueStrings(residualNotes, "residualNotes")
  };
}

export function createFailedBuildResult(message) {
  return {
    status: "failed",
    iterations: 0,
    planSummary: "Builder Agent could not complete the build loop.",
    changedFiles: [],
    review: createFailedReview(message),
    residualNotes: [message]
  };
}

export function uniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Build result ${label} must be an array of non-empty strings.`);
  }

  return [...new Set(value.map((item) => item.trim()))];
}
