import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BuilderAgent } from "../../dist/index.js";
import { createAdapter, failingReview, passingReview } from "../helpers.ts";

describe("BuilderAgent", () => {
  it("returns ready when the first self-review passes", async () => {
    const adapter = createAdapter({ reviews: [passingReview] });
    const result = await new BuilderAgent(adapter).build({ task: "Implement a small feature." });

    assert.equal(result.status, "ready");
    assert.equal(result.iterations, 1);
    assert.equal(result.review.passed, true);
    assert.deepEqual(result.taskUnderstanding, {
      summary: "analysis",
      constraints: []
    });
    assert.deepEqual(result.changedFiles, ["src/feature.js"]);
  });

  it("falls back to normalized request details when analysis has no summary", async () => {
    const adapter = createAdapter({ reviews: [passingReview] });
    adapter.analyzeTask = async () => ({});

    const result = await new BuilderAgent(adapter).build({
      task: "  Implement a small feature.  ",
      goal: "  Preserve verifier handoff evidence.  ",
      constraints: ["  Keep the change additive.  "]
    });

    assert.deepEqual(result.taskUnderstanding, {
      summary: "Task: Implement a small feature.",
      goal: "Preserve verifier handoff evidence.",
      constraints: ["Keep the change additive."]
    });
  });

  it("captures request constraints before later adapter hooks can mutate them", async () => {
    const adapter = createAdapter({ reviews: [passingReview] });
    adapter.createPlan = async ({ request }) => {
      request.constraints.push("Mutated during planning.");
      return { summary: "Implement the requested change." };
    };

    const result = await new BuilderAgent(adapter).build({
      task: "Implement a small feature.",
      constraints: ["Keep the change additive."]
    });

    assert.deepEqual(result.taskUnderstanding.constraints, ["Keep the change additive."]);
  });

  it("runs improve and re-reviews until the threshold is met", async () => {
    const adapter = createAdapter({ reviews: [failingReview, passingReview] });
    const result = await new BuilderAgent(adapter).build({
      task: "Implement a small feature.",
      maxIterations: 2
    });

    assert.equal(result.status, "ready");
    assert.equal(result.iterations, 2);
    assert.equal(adapter.calls.improve, 1);
    assert.deepEqual(result.changedFiles, ["src/feature.js", "test/feature.test.js"]);
  });

  it("stores immutable snapshots for completed iteration artifacts", async () => {
    const mutableReview = {
      ...failingReview,
      mustFix: [...failingReview.mustFix],
      improvementInstructions: [...failingReview.improvementInstructions]
    };
    const adapter = createAdapter({ reviews: [mutableReview, passingReview] });
    const originalImprove = adapter.improve;
    adapter.improve = async (input) => {
      input.review.mustFix.push("mutated review");
      input.instructions.push("mutated instruction");
      return originalImprove(input);
    };

    const result = await new BuilderAgent(adapter).build({
      task: "Implement a small feature.",
      maxIterations: 2
    });

    assert.equal(result.status, "ready");
    assert.deepEqual(result.iterationArtifacts[0].review.mustFix, ["Add tests for the requested behavior."]);
    assert.deepEqual(result.iterationArtifacts[0].improvementInstructions, ["Add targeted tests for the requested behavior."]);
  });

  it("preserves completed iteration artifacts when a later adapter step fails", async () => {
    const adapter = createAdapter({ reviews: [failingReview] });
    adapter.implement = async () => ({
      changedFiles: ["src/feature.js"],
      residualNotes: ["Implemented initial path; verification not rerun."],
      discoveredIssues: [{ title: "Follow-up verifier diagnostic", repo: "verifier" }]
    });
    adapter.improve = async () => {
      throw new Error("adapter improve failed");
    };

    const result = await new BuilderAgent(adapter).build({
      task: "Implement a small feature.",
      maxIterations: 2
    });

    assert.equal(result.status, "failed");
    assert.equal(result.iterations, 1);
    assert.deepEqual(result.changedFiles, ["src/feature.js"]);
    assert.deepEqual(result.discoveredIssues, [{ title: "Follow-up verifier diagnostic", repo: "verifier" }]);
    assert.deepEqual(result.residualNotes, [
      "Implemented initial path; verification not rerun.",
      "adapter improve failed"
    ]);
    assert.equal(result.iterationArtifacts.length, 1);
    assert.equal(result.iterationArtifacts[0].implementationSummary, "Changed files: src/feature.js");
  });

  it("returns blocked when maxIterations is reached without passing", async () => {
    const adapter = createAdapter({ reviews: [failingReview, failingReview] });
    const result = await new BuilderAgent(adapter).build({
      task: "Implement a small feature.",
      maxIterations: 2
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.iterations, 2);
    assert.equal(result.review.passed, false);
    assert.match(result.residualNotes[0], /did not pass/);
  });

  it("returns failed when the adapter contract is incomplete", async () => {
    const result = await new BuilderAgent({}).build({ task: "Implement a small feature." });

    assert.equal(result.status, "failed");
    assert.match(result.review.mustFix[0], /missing required method/);
  });
});
