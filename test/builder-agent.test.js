import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { BuilderAgent, normalizeBuildRequest, normalizeSelfReview } from "../src/index.js";

const execFileAsync = promisify(execFile);

const passingReview = {
  score: 90,
  confidence: 0.8,
  dimensions: {
    requirementFit: 90,
    architectureQuality: 90,
    implementationQuality: 90,
    testQuality: 90,
    maintainability: 90
  },
  mustFix: [],
  shouldFix: [],
  niceToHave: [],
  improvementInstructions: [],
  passed: false
};

const failingReview = {
  score: 70,
  confidence: 0.65,
  dimensions: {
    requirementFit: 70,
    architectureQuality: 80,
    implementationQuality: 70,
    testQuality: 60,
    maintainability: 80
  },
  mustFix: ["Add tests for the requested behavior."],
  shouldFix: [],
  niceToHave: [],
  improvementInstructions: ["Add targeted tests for the requested behavior."],
  passed: false
};

describe("BuilderAgent", () => {
  it("returns ready when the first self-review passes", async () => {
    const adapter = createAdapter({ reviews: [passingReview] });
    const result = await new BuilderAgent(adapter).build({ task: "Implement a small feature." });

    assert.equal(result.status, "ready");
    assert.equal(result.iterations, 1);
    assert.equal(result.review.passed, true);
    assert.deepEqual(result.changedFiles, ["src/feature.js"]);
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

describe("validation", () => {
  it("normalizes build request defaults", () => {
    assert.deepEqual(normalizeBuildRequest({ task: "  Do work.  " }), {
      task: "Do work.",
      constraints: [],
      threshold: 85,
      maxIterations: 3
    });
  });

  it("overrides an incorrect passed flag from self-review input", () => {
    const review = normalizeSelfReview({ ...passingReview, passed: false }, 85);

    assert.equal(review.passed, true);
  });
});

describe("CLI", () => {
  it("runs the build command and writes structured artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const requestPath = join(dir, "request.json");
    const adapterPath = join(dir, "adapter.mjs");
    const outDir = join(dir, "out");

    await writeFile(
      requestPath,
      JSON.stringify({ task: "Implement a small feature.", maxIterations: 1 }, null, 2),
      "utf8"
    );
    await writeFile(
      adapterPath,
      `
export default {
  async analyzeTask() {
    return {};
  },
  async createPlan() {
    return { summary: "Implement the requested change." };
  },
  async implement() {
    return { changedFiles: ["src/feature.js"], residualNotes: [] };
  },
  async selfReview() {
    return ${JSON.stringify(passingReview)};
  },
  async improve() {
    throw new Error("improve should not be called");
  }
};
`,
      "utf8"
    );

    const { stdout } = await execFileAsync(process.execPath, [
      "src/cli.js",
      "build",
      "--request",
      requestPath,
      "--adapter",
      adapterPath,
      "--out",
      outDir
    ]);
    const output = JSON.parse(stdout);
    const result = JSON.parse(await readFile(join(outDir, "build-result.json"), "utf8"));
    const review = JSON.parse(await readFile(join(outDir, "self-review.json"), "utf8"));

    assert.equal(output.status, "ready");
    assert.equal(result.status, "ready");
    assert.equal(review.passed, true);
  });
});

function createAdapter({ reviews }) {
  const calls = {
    improve: 0
  };

  return {
    calls,

    async analyzeTask() {
      return { summary: "analysis" };
    },

    async createPlan() {
      return { summary: "Implement the requested change and update tests." };
    },

    async implement() {
      return {
        changedFiles: ["src/feature.js"],
        residualNotes: []
      };
    },

    async selfReview() {
      return reviews.shift();
    },

    async improve({ implementation }) {
      calls.improve += 1;
      return {
        changedFiles: [...implementation.changedFiles, "test/feature.test.js"],
        residualNotes: []
      };
    }
  };
}
