const DIMENSION_KEYS = [
  "requirementFit",
  "architectureQuality",
  "implementationQuality",
  "testQuality",
  "maintainability"
];

export { DIMENSION_KEYS };

export function isReviewPassed(review, threshold) {
  return review.score >= threshold && review.mustFix.length === 0 && review.confidence >= 0.7;
}

export function normalizeSelfReview(input, threshold) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Self-review must be an object.");
  }

  const review = {
    score: normalizeScore(input.score, "score"),
    confidence: normalizeConfidence(input.confidence),
    dimensions: normalizeDimensions(input.dimensions),
    mustFix: normalizeStringArray(input.mustFix, "mustFix"),
    shouldFix: normalizeStringArray(input.shouldFix, "shouldFix"),
    niceToHave: normalizeStringArray(input.niceToHave, "niceToHave"),
    improvementInstructions: normalizeStringArray(input.improvementInstructions, "improvementInstructions"),
    passed: false
  };

  review.passed = isReviewPassed(review, threshold);
  return review;
}

export function createFailedReview(message) {
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map((key) => [key, 0]));

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

function normalizeDimensions(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Self-review dimensions must be an object.");
  }

  return Object.fromEntries(
    DIMENSION_KEYS.map((key) => [key, normalizeScore(input[key], `dimensions.${key}`)])
  );
}

function normalizeScore(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`Self-review ${label} must be an integer from 0 to 100.`);
  }

  return value;
}

function normalizeConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error("Self-review confidence must be a number from 0 to 1.");
  }

  return value;
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Self-review ${label} must be an array of non-empty strings.`);
  }

  return value.map((item) => item.trim());
}
