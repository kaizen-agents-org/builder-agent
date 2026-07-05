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
      residualNotes: []
    });

    assert.equal(result.review.passed, true);
    assert.deepEqual(result.taskUnderstanding, {
      summary: "Understand the requested behavior before implementation.",
      constraints: ["Keep the change focused."]
    });
    assert.deepEqual(result.discoveredIssues, []);
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

  it("keeps discovered issues optional in the published build result schema", async () => {
    const schema = JSON.parse(await readFile("schemas/build-result.schema.json", "utf8"));

    assert.equal(schema.properties.taskUnderstanding.type, "object");
    assert.equal(schema.required.includes("taskUnderstanding"), true);
    assert.equal(schema.properties.discoveredIssues.type, "array");
    assert.equal(schema.required.includes("discoveredIssues"), false);
  });
});
