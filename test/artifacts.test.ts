import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeBuildArtifacts } from "../dist/artifacts.js";
import { BuilderAgent } from "../dist/index.js";
import { createAdapter, createGitWorkspace, failingReview, passingReview } from "./helpers.ts";

describe("artifacts", () => {
  it("preserves artifacts for each implementation iteration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const outDir = join(dir, "out");
    await mkdir(join(outDir, "iterations", "3"), { recursive: true });
    await writeFile(join(outDir, "iterations", "3", "stale.json"), "stale", "utf8");

    const adapter = createAdapter({ reviews: [failingReview, passingReview] });
    adapter.implement = async () => ({
      summary: "Implemented the first version.",
      changedFiles: ["src/feature.js"],
      residualNotes: ["Tests still need to be added."],
      discoveredIssues: [{
        title: "Verifier warning needs follow-up",
        repo: "verifier",
        expected: "Verifier warnings should include actionable remediation.",
        evidence: "First iteration verifier warning."
      }]
    });
    adapter.improve = async ({ implementation }) => ({
      summary: "Added targeted regression coverage.",
      changedFiles: [...implementation.changedFiles, "test/feature.test.js"],
      residualNotes: [],
      discoveredIssues: [{
        title: "Builder docs need a note",
        repo: "builder-agent",
        expected: "Builder docs should describe the new behavior.",
        evidence: "Second iteration follow-up note."
      }]
    });

    const result = await new BuilderAgent(adapter).build({
      task: "Implement a small feature.",
      maxIterations: 2
    });
    await writeBuildArtifacts(outDir, result);

    const resultText = await readFile(join(outDir, "build-result.json"), "utf8");
    const writtenResult = JSON.parse(resultText);
    const discoveredIssues = JSON.parse(await readFile(join(outDir, "discovered-issues.json"), "utf8"));
    const latestReview = JSON.parse(await readFile(join(outDir, "self-review.json"), "utf8"));
    const iteration1Summary = JSON.parse(await readFile(join(outDir, "iterations", "1", "implementation-summary.json"), "utf8"));
    const iteration1ChangedFiles = JSON.parse(await readFile(join(outDir, "iterations", "1", "changed-files.json"), "utf8"));
    const iteration1DiscoveredIssues = JSON.parse(await readFile(join(outDir, "iterations", "1", "discovered-issues.json"), "utf8"));
    const iteration1Review = JSON.parse(await readFile(join(outDir, "iterations", "1", "self-review.json"), "utf8"));
    const iteration1Instructions = JSON.parse(await readFile(join(outDir, "iterations", "1", "improvement-instructions.json"), "utf8"));
    const iteration1ResidualNotes = JSON.parse(await readFile(join(outDir, "iterations", "1", "residual-notes.json"), "utf8"));
    const iteration2Summary = JSON.parse(await readFile(join(outDir, "iterations", "2", "implementation-summary.json"), "utf8"));
    const iteration2ChangedFiles = JSON.parse(await readFile(join(outDir, "iterations", "2", "changed-files.json"), "utf8"));
    const iteration2DiscoveredIssues = JSON.parse(await readFile(join(outDir, "iterations", "2", "discovered-issues.json"), "utf8"));
    const iteration2Review = JSON.parse(await readFile(join(outDir, "iterations", "2", "self-review.json"), "utf8"));

    assert.equal(writtenResult.status, "ready");
    assert.equal(writtenResult.iterations, 2);
    assert.deepEqual(discoveredIssues, [
      {
        title: "Verifier warning needs follow-up",
        repo: "verifier",
        expected: "Verifier warnings should include actionable remediation.",
        evidence: "First iteration verifier warning."
      },
      {
        title: "Builder docs need a note",
        repo: "builder-agent",
        expected: "Builder docs should describe the new behavior.",
        evidence: "Second iteration follow-up note."
      }
    ]);
    assert.equal(latestReview.passed, true);
    assert.equal(iteration1Summary.summary, "Implemented the first version.");
    assert.deepEqual(iteration1ChangedFiles, ["src/feature.js"]);
    assert.deepEqual(iteration1DiscoveredIssues, [{
      title: "Verifier warning needs follow-up",
      repo: "verifier",
      expected: "Verifier warnings should include actionable remediation.",
      evidence: "First iteration verifier warning."
    }]);
    assert.equal(iteration1Review.passed, false);
    assert.deepEqual(iteration1Instructions, ["Add targeted tests for the requested behavior."]);
    assert.deepEqual(iteration1ResidualNotes, ["Tests still need to be added."]);
    assert.equal(iteration2Summary.summary, "Added targeted regression coverage.");
    assert.deepEqual(iteration2ChangedFiles, ["src/feature.js", "test/feature.test.js"]);
    assert.deepEqual(iteration2DiscoveredIssues, [{
      title: "Builder docs need a note",
      repo: "builder-agent",
      expected: "Builder docs should describe the new behavior.",
      evidence: "Second iteration follow-up note."
    }]);
    assert.equal(iteration2Review.passed, true);
    assert.equal(Object.hasOwn(writtenResult, "iterationArtifacts"), false);
    await assert.rejects(readFile(join(outDir, "iterations", "3", "stale.json"), "utf8"));
  });

  it("writes reconciled changed files to final and iteration artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const workspaceDir = await createGitWorkspace();
    const outDir = join(dir, "out");
    const adapter = createAdapter({ reviews: [passingReview] });
    adapter.implement = async () => {
      await writeFile(join(workspaceDir, "src", "feature.js"), "export const value = 2;\n", "utf8");
      return {
        summary: "Updated feature implementation.",
        residualNotes: []
      };
    };

    const result = await new BuilderAgent(adapter, { workspaceDir }).build({ task: "Implement a small feature." });
    await writeBuildArtifacts(outDir, result);

    const writtenResult = JSON.parse(await readFile(join(outDir, "build-result.json"), "utf8"));
    const iterationChangedFiles = JSON.parse(await readFile(join(outDir, "iterations", "1", "changed-files.json"), "utf8"));

    assert.deepEqual(writtenResult.changedFiles, ["src/feature.js"]);
    assert.deepEqual(iterationChangedFiles, ["src/feature.js"]);
  });
});
