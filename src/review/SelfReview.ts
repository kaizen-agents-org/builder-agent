import type { SelfReviewDimensions, SelfReviewResult } from "../types/contracts.js";

const DIMENSION_KEYS = [
  "requirementFit",
  "architectureQuality",
  "implementationQuality",
  "testQuality",
  "maintainability"
];
const REVIEW_KEYS = new Set([
  "score",
  "confidence",
  "dimensions",
  "mustFix",
  "shouldFix",
  "niceToHave",
  "improvementInstructions",
  "passed"
]);
const DIMENSION_KEY_SET = new Set(DIMENSION_KEYS);

export { DIMENSION_KEYS };

export function isReviewPassed(review: SelfReviewResult, threshold: number): boolean {
  return review.score >= threshold && review.mustFix.length === 0 && review.confidence >= 0.7;
}

export function normalizeSelfReview(input: unknown, threshold: number): SelfReviewResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Self-review must be an object.");
  }
  assertAllowedKeys(input, REVIEW_KEYS, "Self-review");
  const reviewInput = input as Record<string, unknown>;

  if (typeof reviewInput.passed !== "boolean") {
    throw new Error("Self-review passed must be a boolean.");
  }

  const review: SelfReviewResult = {
    score: normalizeScore(reviewInput.score, "score"),
    confidence: normalizeConfidence(reviewInput.confidence),
    dimensions: normalizeDimensions(reviewInput.dimensions),
    mustFix: normalizeStringArray(reviewInput.mustFix, "mustFix"),
    shouldFix: normalizeStringArray(reviewInput.shouldFix, "shouldFix"),
    niceToHave: normalizeStringArray(reviewInput.niceToHave, "niceToHave"),
    improvementInstructions: normalizeStringArray(reviewInput.improvementInstructions, "improvementInstructions"),
    passed: false
  };

  review.passed = isReviewPassed(review, threshold);
  return review;
}

export function createFailedReview(message: string): SelfReviewResult {
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map((key) => [key, 0])) as unknown as SelfReviewDimensions;

  return {
    score: 0,
    confidence: 0,
    dimensions,
    mustFix: [message],
    shouldFix: [],
    niceToHave: [],
    improvementInstructions: [],
    passed: false
  };
}

function normalizeDimensions(input: unknown): SelfReviewDimensions {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Self-review dimensions must be an object.");
  }
  assertAllowedKeys(input, DIMENSION_KEY_SET, "Self-review dimensions");
  const dimensions = input as Record<string, unknown>;

  return Object.fromEntries(
    DIMENSION_KEYS.map((key) => [key, normalizeScore(dimensions[key], `dimensions.${key}`)])
  ) as unknown as SelfReviewDimensions;
}

function normalizeScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`Self-review ${label} must be an integer from 0 to 100.`);
  }

  return value;
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error("Self-review confidence must be a number from 0 to 1.");
  }

  return value;
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Self-review ${label} must be an array of non-empty strings.`);
  }

  return value.map((item) => item.trim());
}

function assertAllowedKeys(input: object, allowedKeys: Set<string>, label: string): void {
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));

  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
  }
}
