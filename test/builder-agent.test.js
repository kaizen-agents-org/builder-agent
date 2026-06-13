import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { BuilderAgent, normalizeBuildRequest, normalizeBuildResult, normalizeSelfReview } from "../src/index.js";

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

  it("rejects unknown build request fields", () => {
    assert.throws(
      () => normalizeBuildRequest({ task: "Do work.", extra: true }),
      /unknown field/
    );
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

  it("normalizes build result artifacts with the published schema shape", () => {
    const result = normalizeBuildResult({
      status: "ready",
      iterations: 1,
      planSummary: "Implement the requested change.",
      changedFiles: ["src/feature.js"],
      review: passingReview,
      residualNotes: []
    });

    assert.equal(result.review.passed, true);
    assert.throws(
      () => normalizeBuildResult({ ...result, extra: true }),
      /unknown field/
    );
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

  it("supports the kaizen-loop stdin/result-file contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeClaudePath, 0o755);

    const { stdout } = await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "claude"
      }
    });

    const output = JSON.parse(stdout);
    const result = JSON.parse(await readFile(resultPath, "utf8"));

    assert.equal(output.status, "fixed");
    assert.equal(result.status, "fixed");
    assert.equal(result.summary, "implemented");
  });

  it("supports the kaizen-loop contract with the codex backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    const argsPath = join(dir, "codex-args.json");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
const outputIndex = args.indexOf("--output-last-message");
writeFileSync(args[outputIndex + 1], JSON.stringify({
  status: "fixed",
  summary: "implemented with codex",
  notes: "checked"
}));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);

    const { stdout } = await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "codex"
      }
    });

    const output = JSON.parse(stdout);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    const args = JSON.parse(await readFile(argsPath, "utf8"));

    assert.equal(output.status, "fixed");
    assert.equal(result.status, "fixed");
    assert.equal(result.summary, "implemented with codex");
    assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--sandbox", "workspace-write", "-C"]);
    assert.equal(args.includes("--ask-for-approval"), false);
  });

  it("creates the kaizen-loop result directory when it is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, ".kaizen", "builder", "build-result.json");
    await mkdir(binDir);
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeClaudePath, 0o755);

    await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "claude"
      }
    });

    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.status, "fixed");
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

function spawnWithInput(command, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command exited with ${code}: ${stderr}${stdout}`));
      }
    });
    child.stdin.end(input);
  });
}
