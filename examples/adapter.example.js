export function createAdapter() {
  let reviewCount = 0;

  return {
    async analyzeTask({ request }) {
      return {
        summary: `Analyze: ${request.task}`,
        assumptions: []
      };
    },

    async createPlan() {
      return {
        summary: "Create a focused implementation, update tests, and self-review the result."
      };
    },

    async implement() {
      return {
        changedFiles: ["src/example-change.js"],
        verification: [{
          command: "npm test -- --test-name-pattern=example-change",
          status: "skipped",
          summary: "Skipped until focused coverage is added in the improvement iteration."
        }],
        residualNotes: []
      };
    },

    async selfReview() {
      reviewCount += 1;

      return {
        score: reviewCount === 1 ? 72 : 88,
        confidence: reviewCount === 1 ? 0.66 : 0.8,
        dimensions: {
          requirementFit: reviewCount === 1 ? 70 : 90,
          architectureQuality: 85,
          implementationQuality: reviewCount === 1 ? 70 : 88,
          testQuality: reviewCount === 1 ? 60 : 85,
          maintainability: 86
        },
        mustFix: reviewCount === 1 ? ["Add focused test coverage before marking ready."] : [],
        shouldFix: [],
        niceToHave: [],
        improvementInstructions: reviewCount === 1 ? ["Add or update a targeted test for the implemented behavior."] : []
        // `passed` is intentionally omitted: the controller always recomputes it.
      };
    },

    async improve({ implementation }) {
      return {
        changedFiles: [...implementation.changedFiles, "test/example-change.test.js"],
        verification: [{
          command: "npm test -- --test-name-pattern=example-change",
          status: "passed",
          summary: "The focused regression test passed."
        }],
        residualNotes: []
      };
    }
  };
}
