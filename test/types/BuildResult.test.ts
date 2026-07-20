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
        summary: "Understand the requested behavior before implementation.",
        constraints: ["Keep the change focused."]
      },
      planSummary: "Implement the requested change.",
      changedFiles: ["src/feature.js"],
      review: passingReview,
      verification: [{
        command: "  npm test  ",
        status: "passed",
        summary: "  All tests passed.  "
      }],
      residualNotes: []
    });

    assert.equal(result.review.passed, true);
    assert.deepEqual(result.taskUnderstanding, {
      summary: "Understand the requested behavior before implementation.",
      constraints: ["Keep the change focused."]
    });
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

    assert.deepEqual(normalizeBuildResult(base).verification, []);
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

  it("keeps discovered issues optional in the published build result schema", async () => {
    const schema = JSON.parse(await readFile("schemas/build-result.schema.json", "utf8"));

    assert.equal(schema.properties.taskUnderstanding.type, "object");
    assert.equal(schema.required.includes("taskUnderstanding"), true);
    assert.equal(schema.required.includes("verification"), true);
    assert.deepEqual(schema.properties.verification.items.required, ["command", "status", "summary"]);
    assert.deepEqual(schema.properties.verification.items.properties.status.enum, ["passed", "failed", "skipped"]);
    assert.equal(schema.properties.discoveredIssues.type, "array");
    assert.deepEqual(schema.properties.discoveredIssues.items.required, ["title", "expected", "evidence"]);
    assert.equal(schema.properties.discoveredIssues.items.properties.expected.pattern, "\\S");
    assert.equal(schema.properties.discoveredIssues.items.properties.evidence.pattern, "\\S");
    assert.equal(schema.required.includes("discoveredIssues"), false);
  });
});
