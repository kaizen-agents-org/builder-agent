import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReviewPassed, normalizeSelfReview } from "../../dist/index.js";
import { passingReview } from "../helpers.ts";

describe("SelfReview", () => {
  it("recomputes passing from score, must-fix items, and confidence", () => {
    assert.equal(isReviewPassed({ ...passingReview, score: 85, confidence: 0.7, mustFix: [] }, 85), true);
    assert.equal(isReviewPassed({ ...passingReview, score: 84, confidence: 1, mustFix: [] }, 85), false);
    assert.equal(isReviewPassed({ ...passingReview, score: 100, confidence: 1, mustFix: ["Fix it."] }, 85), false);
    assert.equal(isReviewPassed({ ...passingReview, score: 100, confidence: 0.69, mustFix: [] }, 85), false);
  });

  it("overrides an incorrect passed flag from self-review input", () => {
    const review = normalizeSelfReview({ ...passingReview, passed: false }, 85);

    assert.equal(review.passed, true);
  });

  it("requires self-review input to match the published schema shape", () => {
    assert.throws(
      () => normalizeSelfReview({ ...passingReview, passed: undefined }, 85),
      /passed must be a boolean/
    );
    assert.throws(
      () => normalizeSelfReview({
        ...passingReview,
        dimensions: { ...passingReview.dimensions, security: 90 }
      }, 85),
      /unknown field/
    );
  });
});
