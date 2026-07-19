import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BuilderAgent } from "../../dist/index.js";
import { createAdapter, createGitWorkspace, execGit, failingReview, passingReview } from "../helpers.ts";

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
    assert.deepEqual(result.verification, []);
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

  it("accumulates normalized verification evidence while preserving iteration snapshots", async () => {
    const adapter = createAdapter({ reviews: [failingReview, passingReview] });
    adapter.implement = async () => ({
      changedFiles: ["src/feature.js"],
      verification: [{
        command: " npm test -- --test-name-pattern=feature ",
        status: "skipped",
        summary: " Focused coverage has not been added yet. "
      }],
      residualNotes: []
    });
    adapter.improve = async ({ implementation }) => ({
      changedFiles: [...implementation.changedFiles, "test/feature.test.js"],
      verification: [{
        command: "npm test -- --test-name-pattern=feature",
        status: "passed",
        summary: "The focused regression test passed."
      }],
      residualNotes: []
    });

    const result = await new BuilderAgent(adapter).build({
      task: "Implement a small feature.",
      maxIterations: 2
    });

    assert.deepEqual(result.verification, [
      {
        command: "npm test -- --test-name-pattern=feature",
        status: "skipped",
        summary: "Focused coverage has not been added yet."
      },
      {
        command: "npm test -- --test-name-pattern=feature",
        status: "passed",
        summary: "The focused regression test passed."
      }
    ]);
    assert.deepEqual(result.iterationArtifacts[0].verification, [result.verification[0]]);
    assert.deepEqual(result.iterationArtifacts[1].verification, [result.verification[1]]);
  });

  it("reconciles adapter changed files with workspace changes", async () => {
    const workspaceDir = await createGitWorkspace();
    const adapter = createAdapter({ reviews: [passingReview] });
    adapter.implement = async () => {
      await writeFile(join(workspaceDir, "src", "feature.js"), "export const value = 2;\n", "utf8");
      return {
        summary: "Updated feature implementation.",
        residualNotes: []
      };
    };

    const result = await new BuilderAgent(adapter, { workspaceDir }).build({ task: "Implement a small feature." });

    assert.deepEqual(result.changedFiles, ["src/feature.js"]);
    assert.deepEqual(result.iterationArtifacts[0].changedFiles, ["src/feature.js"]);
  });

  it("does not report dirty files that predate the build", async () => {
    const workspaceDir = await createGitWorkspace();
    await writeFile(join(workspaceDir, "src", "feature.js"), "export const value = 2;\n", "utf8");
    const adapter = createAdapter({ reviews: [passingReview] });
    adapter.implement = async () => ({
      changedFiles: [],
      residualNotes: []
    });

    const result = await new BuilderAgent(adapter, { workspaceDir }).build({ task: "Implement a small feature." });

    assert.deepEqual(result.changedFiles, []);
    assert.deepEqual(await execGit(["diff", "--name-only", "HEAD", "--"], workspaceDir), "src/feature.js\n");
  });

  it("reports dirty files that are edited during the build", async () => {
    const workspaceDir = await createGitWorkspace();
    const featurePath = join(workspaceDir, "src", "feature.js");
    await writeFile(featurePath, "export const value = 2;\n", "utf8");
    const adapter = createAdapter({ reviews: [passingReview] });
    adapter.implement = async () => {
      await writeFile(featurePath, "export const value = 3;\n", "utf8");
      return {
        changedFiles: [],
        residualNotes: []
      };
    };

    const result = await new BuilderAgent(adapter, { workspaceDir }).build({ task: "Implement a small feature." });

    assert.deepEqual(result.changedFiles, ["src/feature.js"]);
    assert.deepEqual(result.iterationArtifacts[0].changedFiles, ["src/feature.js"]);
  });

  it("does not fail when workspace change reconciliation cannot run", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "builder-agent-no-git-"));
    const adapter = createAdapter({ reviews: [passingReview] });
    adapter.implement = async () => ({
      changedFiles: [],
      residualNotes: []
    });

    const result = await new BuilderAgent(adapter, { workspaceDir }).build({ task: "Implement a small feature." });

    assert.equal(result.status, "ready");
    assert.deepEqual(result.changedFiles, []);
    assert.match(result.residualNotes[0], /Workspace changed-files reconciliation could not run/);
  });

  it("stores immutable snapshots for completed iteration artifacts", async () => {
    const mutableReview = {
      ...failingReview,
      mustFix: [...failingReview.mustFix],
      improvementInstructions: [...failingReview.improvementInstructions]
    };
    const adapter = createAdapter({ reviews: [mutableReview, passingReview] });
    adapter.implement = async () => ({
      changedFiles: ["src/feature.js"],
      verification: [{ command: "npm test", status: "passed", summary: "Tests passed." }],
      residualNotes: []
    });
    const originalImprove = adapter.improve;
    adapter.improve = async (input) => {
      input.review.mustFix.push("mutated review");
      input.instructions.push("mutated instruction");
      input.implementation.verification[0].summary = "mutated verification";
      return originalImprove(input);
    };

    const result = await new BuilderAgent(adapter).build({
      task: "Implement a small feature.",
      maxIterations: 2
    });

    assert.equal(result.status, "ready");
    assert.deepEqual(result.iterationArtifacts[0].review.mustFix, ["Add tests for the requested behavior."]);
    assert.deepEqual(result.iterationArtifacts[0].improvementInstructions, ["Add targeted tests for the requested behavior."]);
    assert.equal(result.iterationArtifacts[0].verification[0].summary, "Tests passed.");
    assert.equal(result.verification[0].summary, "Tests passed.");
  });

  it("preserves completed iteration artifacts when a later adapter step fails", async () => {
    const adapter = createAdapter({ reviews: [failingReview] });
    adapter.implement = async () => ({
      changedFiles: ["src/feature.js"],
      verification: [{
        command: "npm test -- --test-name-pattern=feature",
        status: "skipped",
        summary: "The adapter failed before the focused check could be rerun."
      }],
      residualNotes: ["Implemented initial path; verification not rerun."],
      discoveredIssues: [{
        title: "Follow-up verifier diagnostic",
        repo: "verifier",
        expected: "Verifier diagnostics should identify the failing check.",
        evidence: "Adapter reported an incomplete verifier diagnostic."
      }]
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
    assert.deepEqual(result.discoveredIssues, [{
      title: "Follow-up verifier diagnostic",
      repo: "verifier",
      expected: "Verifier diagnostics should identify the failing check.",
      evidence: "Adapter reported an incomplete verifier diagnostic."
    }]);
    assert.deepEqual(result.residualNotes, [
      "Implemented initial path; verification not rerun.",
      "adapter improve failed"
    ]);
    assert.deepEqual(result.verification, [{
      command: "npm test -- --test-name-pattern=feature",
      status: "skipped",
      summary: "The adapter failed before the focused check could be rerun."
    }]);
    assert.equal(result.iterationArtifacts.length, 1);
    assert.deepEqual(result.iterationArtifacts[0].verification, result.verification);
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
