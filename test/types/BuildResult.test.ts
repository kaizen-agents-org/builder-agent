import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { normalizeBuildResult } from "../../dist/index.js";
import { passingReview } from "../helpers.ts";

describe("BuildResult", () => {
  it("normalizes build result artifacts with the published schema shape", () => {
    const result = normalizeBuildResult({
      status: "ready",
      iterations: 1,
      taskUnderstanding: {
        summary: "  Understand the requested behavior before implementation.  ",
        goal: "  Keep runtime and schema validation aligned.  ",
        constraints: ["  Keep the change focused.  "]
      },
      planSummary: "  Implement the requested change.  ",
      changedFiles: ["  src/feature.js  "],
      review: passingReview,
      verification: [{
        command: "  npm test  ",
        status: "passed",
        summary: "  All tests passed.  "
      }],
      residualNotes: ["  No remaining caveats.  "]
    });

    assert.equal(result.review.passed, true);
    assert.deepEqual(result.taskUnderstanding, {
      summary: "Understand the requested behavior before implementation.",
      goal: "Keep runtime and schema validation aligned.",
      constraints: ["Keep the change focused."]
    });
    assert.equal(result.planSummary, "Implement the requested change.");
    assert.deepEqual(result.changedFiles, ["src/feature.js"]);
    assert.deepEqual(result.residualNotes, ["No remaining caveats."]);
    assert.deepEqual(result.discoveredIssues, []);
    assert.deepEqual(result.verification, [{
      command: "npm test",
      status: "passed",
      summary: "All tests passed."
    }]);
    assert.throws(
      () => normalizeBuildResult({ ...result, extra: true }),
      /unknown field/
    );
    assert.throws(
      () => normalizeBuildResult({
        status: "ready",
        iterations: 1,
        planSummary: "Implement the requested change.",
        changedFiles: ["src/feature.js"],
        review: passingReview,
        verification: [],
        residualNotes: []
      }),
      /taskUnderstanding is required/
    );
    assert.throws(
      () => normalizeBuildResult({
        ...result,
        taskUnderstanding: {
          summary: "Understand the requested behavior before implementation."
        }
      }),
      /taskUnderstanding\.constraints is required/
    );
  });

  it("computes passed on the final review artifact even when the adapter omits it", () => {
    const { passed, ...reviewWithoutPassed } = passingReview;

    const result = normalizeBuildResult({
      status: "ready",
      iterations: 1,
      taskUnderstanding: {
        summary: "Understand the requested behavior before implementation.",
        constraints: ["Keep the change focused."]
      },
      planSummary: "Implement the requested change.",
      changedFiles: ["src/feature.js"],
      review: reviewWithoutPassed,
      verification: [],
      residualNotes: []
    });

    assert.equal(result.review.passed, true);
  });

  it("normalizes discovered issues in build results", () => {
    const result = normalizeBuildResult({
      status: "ready",
      iterations: 1,
      taskUnderstanding: {
        summary: "Understand the requested behavior before implementation.",
        constraints: ["Keep the change focused."]
      },
      planSummary: "Implement the requested change.",
      changedFiles: ["src/feature.js"],
      review: passingReview,
      verification: [],
      residualNotes: [],
      discoveredIssues: [
        {
          title: "  Verifier false-positive on legacy status text  ",
          repo: "verifier",
          body: "Observed during the run.",
          expected: "The verifier should ignore plain status words in summaries.",
          evidence: "verifier.log",
          labels: ["kaizen", "kaizen"]
        }
      ]
    });

    assert.deepEqual(result.discoveredIssues, [
      {
        title: "Verifier false-positive on legacy status text",
        repo: "verifier",
        body: "Observed during the run.",
        expected: "The verifier should ignore plain status words in summaries.",
        evidence: "verifier.log",
        labels: ["kaizen"]
      }
    ]);
  });

  it("rejects title-only discovered issues in build results", () => {
    assert.throws(
      () => normalizeBuildResult({
        status: "ready",
        iterations: 1,
        taskUnderstanding: {
          summary: "Understand the requested behavior before implementation.",
          constraints: ["Keep the change focused."]
        },
        planSummary: "Implement the requested change.",
        changedFiles: ["src/feature.js"],
        review: passingReview,
        verification: [],
        residualNotes: [],
        discoveredIssues: [{ title: "Title-only follow-up" }]
      }),
      /Build result discoveredIssues\[0\]\.expected must be a non-empty string/
    );
  });

  it("rejects malformed verification evidence", () => {
    const base = {
      status: "ready",
      iterations: 1,
      taskUnderstanding: { summary: "Implement the request.", constraints: [] },
      planSummary: "Implement the request.",
      changedFiles: [],
      review: passingReview,
      residualNotes: []
    };

    assert.throws(
      () => normalizeBuildResult(base),
      /verification is required/
    );
    assert.deepEqual(normalizeBuildResult({ ...base, verification: [] }).verification, []);
    assert.throws(
      () => normalizeBuildResult({ ...base, verification: [{ command: "npm test", status: "unknown", summary: "Done." }] }),
      /status must be one of: passed, failed, skipped/
    );
    assert.throws(
      () => normalizeBuildResult({ ...base, verification: [{ command: "npm test", status: "skipped", summary: " " }] }),
      /summary must be a non-empty string/
    );
    assert.throws(
      () => normalizeBuildResult({ ...base, verification: [{ command: "npm test", status: "passed", summary: "Done.", extra: true }] }),
      /contains unknown field/
    );
  });

  it("rejects whitespace-only handoff strings at runtime", () => {
    const base = normalizeBuildResult({
      status: "ready",
      iterations: 1,
      taskUnderstanding: { summary: "Implement the request.", constraints: ["Keep it focused."] },
      planSummary: "Implement the request.",
      changedFiles: ["src/feature.js"],
      review: passingReview,
      verification: [],
      residualNotes: ["No remaining caveats."]
    });
    const invalidResults = [
      { input: { ...base, planSummary: " \n\t " }, error: /planSummary must be a non-empty string/ },
      { input: { ...base, taskUnderstanding: { ...base.taskUnderstanding, summary: " \n\t " } }, error: /taskUnderstanding\.summary must be a non-empty string/ },
      { input: { ...base, taskUnderstanding: { ...base.taskUnderstanding, goal: " \n\t " } }, error: /taskUnderstanding\.goal must be a non-empty string/ },
      { input: { ...base, taskUnderstanding: { ...base.taskUnderstanding, constraints: [" \n\t "] } }, error: /taskUnderstanding\.constraints must be an array of non-empty strings/ },
      { input: { ...base, changedFiles: [" \n\t "] }, error: /changedFiles must be an array of non-empty strings/ },
      { input: { ...base, residualNotes: [" \n\t "] }, error: /residualNotes must be an array of non-empty strings/ }
    ];

    for (const { input, error } of invalidResults) {
      assert.throws(() => normalizeBuildResult(input), error);
    }
  });

  it("publishes runtime-aligned non-whitespace constraints in the build result schema", async () => {
    const schema = JSON.parse(await readFile("schemas/build-result.schema.json", "utf8"));

    assert.equal(schema.properties.taskUnderstanding.type, "object");
    assert.equal(schema.required.includes("taskUnderstanding"), true);
    assert.equal(schema.properties.taskUnderstanding.properties.summary.pattern, "\\S");
    assert.equal(schema.properties.taskUnderstanding.properties.goal.pattern, "\\S");
    assert.equal(schema.properties.taskUnderstanding.properties.constraints.items.pattern, "\\S");
    assert.equal(schema.properties.planSummary.pattern, "\\S");
    assert.equal(schema.properties.changedFiles.items.pattern, "\\S");
    assert.equal(schema.properties.residualNotes.items.pattern, "\\S");
    assert.equal(schema.required.includes("verification"), true);
    assert.deepEqual(schema.properties.verification.items.required, ["command", "status", "summary"]);
    assert.deepEqual(schema.properties.verification.items.properties.status.enum, ["passed", "failed", "skipped"]);
    assert.equal(schema.properties.discoveredIssues.type, "array");
    assert.deepEqual(schema.properties.discoveredIssues.items.required, ["title", "expected", "evidence"]);
    const discoveredIssueProperties = schema.properties.discoveredIssues.items.properties;
    for (const field of ["title", "body", "expected", "evidence", "repo", "severity"]) {
      assert.equal(discoveredIssueProperties[field].pattern, "\\S");
    }
    assert.equal(discoveredIssueProperties.labels.items.pattern, "\\S");
    assert.equal(schema.required.includes("discoveredIssues"), false);
  });
});
