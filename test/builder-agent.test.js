import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { BuilderAgent, normalizeAgent, normalizeAgents, normalizeBuildRequest, normalizeBuildResult, normalizeKaizenLoopPayload, normalizeSelfReview } from "../src/index.js";

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
    adapter.improve = async () => {
      throw new Error("adapter improve failed");
    };

    const result = await new BuilderAgent(adapter).build({
      task: "Implement a small feature.",
      maxIterations: 2
    });

    assert.equal(result.status, "failed");
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

describe("validation", () => {
  it("normalizes build request defaults", () => {
    assert.deepEqual(normalizeBuildRequest({ task: "  Do work.  " }), {
      task: "Do work.",
      constraints: [],
      threshold: 85,
      maxIterations: 3
    });
  });

  it("normalizes agent defaults to codex first", () => {
    assert.deepEqual(normalizeAgents(undefined), ["codex", "claude"]);
    assert.equal(normalizeAgent(undefined), "codex");
  });

  it("normalizes custom provider fallbacks to codex first", () => {
    assert.deepEqual(normalizeAgents("opencode-go"), ["opencode-go", "codex", "claude"]);
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
    assert.deepEqual(result.discoveredIssues, []);
    assert.throws(
      () => normalizeBuildResult({ ...result, extra: true }),
      /unknown field/
    );
  });

  it("documents builder handoff as reviewable evidence, not approval", async () => {
    const [readme, skill, implementPrompt, selfReviewPrompt, improvePrompt] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("SKILL.md", "utf8"),
      readFile("prompts/implement.md", "utf8"),
      readFile("prompts/self-review.md", "utf8"),
      readFile("prompts/improve.md", "utf8")
    ]);
    const handoffGuidance = `${readme}\n${skill}\n${implementPrompt}\n${selfReviewPrompt}\n${improvePrompt}`;

    assert.doesNotMatch(readme, /approved task/i);
    assert.match(readme, /accepted issue or scoped task/i);
    assert.match(handoffGuidance, /what changed/i);
    assert.match(handoffGuidance, /why/i);
    assert.match(handoffGuidance, /verification run or skipped/i);
    assert.match(handoffGuidance, /residual risk/i);
    assert.match(handoffGuidance, /reviewer notes/i);
    assert.match(handoffGuidance, /not approval/i);
  });

  it("normalizes discovered issues in build results", () => {
    const result = normalizeBuildResult({
      status: "ready",
      iterations: 1,
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

    assert.equal(schema.properties.discoveredIssues.type, "array");
    assert.equal(schema.required.includes("discoveredIssues"), false);
  });

  it("normalizes kaizen-loop payloads with the published schema shape", () => {
    const payload = normalizeKaizenLoopPayload({
      status: "partial",
      summary: "  Implemented most of the change.  ",
      notes: "Ran targeted checks.",
      discoveredIssues: [
        {
          title: "  Missing verifier diagnostic  ",
          repo: " verifier ",
          labels: ["kaizen", "kaizen"]
        }
      ]
    });

    assert.deepEqual(payload, {
      status: "partial",
      summary: "  Implemented most of the change.  ",
      notes: "Ran targeted checks.",
      discoveredIssues: [
        {
          title: "Missing verifier diagnostic",
          repo: "verifier",
          labels: ["kaizen"]
        }
      ]
    });
  });

  it("rejects malformed kaizen-loop discovered issues explicitly", () => {
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "fixed",
        summary: "Implemented.",
        notes: "",
        discoveredIssues: [{ repo: "verifier" }]
      }),
      /discoveredIssues\[0\]\.title/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "fixed",
        summary: "Implemented.",
        notes: "",
        discoveredIssues: [{ title: "Bad routing", repo: 123 }]
      }),
      /discoveredIssues\[0\]\.repo must be a string/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "blocked",
        summary: "Blocked.",
        notes: "",
        blockedReason: false
      }),
      /blockedReason must be a string/
    );
  });

  it("publishes the kaizen-loop payload schema", async () => {
    const schema = JSON.parse(await readFile("schemas/kaizen-loop-payload.schema.json", "utf8"));

    assert.deepEqual(schema.properties.status.enum, ["fixed", "partial", "blocked"]);
    assert.equal(schema.properties.discoveredIssues.items.properties.repo.type, "string");
    assert.equal(schema.required.includes("discoveredIssues"), false);
  });
});

describe("TypeScript build boundaries", () => {
  it("emits declarations for reusable builder contracts and runners", async () => {
    const [entrypoint, contracts, buildRequest, kaizenLoopPayload, builderAgent, agentRunner] = await Promise.all([
      readFile("dist/index.d.ts", "utf8"),
      readFile("dist/types/contracts.d.ts", "utf8"),
      readFile("dist/types/BuildRequest.d.ts", "utf8"),
      readFile("dist/types/KaizenLoopPayload.d.ts", "utf8"),
      readFile("dist/builder/BuilderAgent.d.ts", "utf8"),
      readFile("dist/agents/AgentRunner.d.ts", "utf8")
    ]);

    assert.match(entrypoint, /export type BuildRequest = import\("\.\/types\/contracts\.js"\)\.BuildRequest/);
    assert.match(entrypoint, /export type BuilderAdapter = import\("\.\/types\/contracts\.js"\)\.BuilderAdapter/);
    assert.match(contracts, /export interface BuilderAdapter/);
    assert.match(contracts, /export interface KaizenLoopPayload/);
    assert.match(buildRequest, /normalizeBuildRequest\(input: BuildRequestInput\): BuildRequest/);
    assert.match(kaizenLoopPayload, /normalizeKaizenLoopPayload\(input: unknown\): import\("\.\/contracts\.js"\)\.KaizenLoopPayload/);
    assert.match(builderAgent, /build\(input: BuildRequestInput\): Promise<BuildResult>/);
    assert.match(agentRunner, /runImplementationAgent\([^)]*AgentRunInput[^)]*\): Promise<AgentRunResult>/);
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

  it("preserves artifacts for each implementation iteration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const requestPath = join(dir, "request.json");
    const adapterPath = join(dir, "adapter.mjs");
    const outDir = join(dir, "out");

    await writeFile(
      requestPath,
      JSON.stringify({ task: "Implement a small feature.", maxIterations: 2 }, null, 2),
      "utf8"
    );
    await mkdir(join(outDir, "iterations", "3"), { recursive: true });
    await writeFile(join(outDir, "iterations", "3", "stale.json"), "stale", "utf8");
    await writeFile(
      adapterPath,
      `
let reviewCount = 0;

export default {
  async analyzeTask() {
    return {};
  },
  async createPlan() {
    return { summary: "Implement the requested change." };
  },
  async implement() {
    return {
      summary: "Implemented the first version.",
      changedFiles: ["src/feature.js"],
      residualNotes: ["Tests still need to be added."]
    };
  },
  async selfReview() {
    reviewCount += 1;
    return reviewCount === 1 ? ${JSON.stringify(failingReview)} : ${JSON.stringify(passingReview)};
  },
  async improve({ implementation }) {
    return {
      summary: "Added targeted regression coverage.",
      changedFiles: [...implementation.changedFiles, "test/feature.test.js"],
      residualNotes: []
    };
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
    const resultText = await readFile(join(outDir, "build-result.json"), "utf8");
    const result = JSON.parse(resultText);
    const latestReview = JSON.parse(await readFile(join(outDir, "self-review.json"), "utf8"));
    const iteration1Summary = JSON.parse(await readFile(join(outDir, "iterations", "1", "implementation-summary.json"), "utf8"));
    const iteration1Review = JSON.parse(await readFile(join(outDir, "iterations", "1", "self-review.json"), "utf8"));
    const iteration1Instructions = JSON.parse(await readFile(join(outDir, "iterations", "1", "improvement-instructions.json"), "utf8"));
    const iteration1ResidualNotes = JSON.parse(await readFile(join(outDir, "iterations", "1", "residual-notes.json"), "utf8"));
    const iteration2Summary = JSON.parse(await readFile(join(outDir, "iterations", "2", "implementation-summary.json"), "utf8"));
    const iteration2Review = JSON.parse(await readFile(join(outDir, "iterations", "2", "self-review.json"), "utf8"));

    assert.equal(output.status, "ready");
    assert.equal(result.status, "ready");
    assert.equal(result.iterations, 2);
    assert.equal(latestReview.passed, true);
    assert.equal(iteration1Summary.summary, "Implemented the first version.");
    assert.equal(iteration1Review.passed, false);
    assert.deepEqual(iteration1Instructions, ["Add targeted tests for the requested behavior."]);
    assert.deepEqual(iteration1ResidualNotes, ["Tests still need to be added."]);
    assert.equal(iteration2Summary.summary, "Added targeted regression coverage.");
    assert.equal(iteration2Review.passed, true);
    assert.equal(Object.hasOwn(result, "iterationArtifacts"), false);
    await assert.rejects(readFile(join(outDir, "iterations", "3", "stale.json"), "utf8"));
  });

  it("supports the kaizen-loop stdin/result-file contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("codex fallback disabled for this fixture");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented\",\"notes\":\"checked\",\"discoveredIssues\":[{\"title\":\"Verifier false positive\",\"repo\":\"verifier\",\"evidence\":\"log excerpt\"}]}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
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
    assert.deepEqual(result.discoveredIssues, [
      {
        title: "Verifier false positive",
        repo: "verifier",
        evidence: "log excerpt"
      }
    ]);
  });

  it("supports the kaizen-loop contract with the codex backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    const argsPath = join(dir, "codex-args.json");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeCodexPath = join(binDir, "codex");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
const outputIndex = args.indexOf("--output-last-message");
writeFileSync(args[outputIndex + 1], JSON.stringify({
  status: "fixed",
  summary: "implemented with codex",
  notes: "checked"
}));
})();
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

  it("treats malformed kaizen-loop provider payloads as invalid instead of dropping discovered issues", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented\",\"notes\":\"checked\",\"discoveredIssues\":[{\"repo\":\"verifier\"}]}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeClaudePath, 0o755);

    await assert.rejects(
      spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          KAIZEN_BUILD_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: dir,
          KAIZEN_PREFERRED_AGENT: "claude"
        }
      }),
      /Command exited with 2/
    );

    const result = JSON.parse(await readFile(resultPath, "utf8"));

    assert.equal(result.status, "blocked");
    assert.equal(result.summary, "Builder agent exited with code 1.");
    assert.match(result.notes, /Agent "claude" exited with code 0/);
    assert.match(result.notes, /Failure class: invalid_payload/);
    assert.deepEqual(result.discoveredIssues, []);
  });

  it("falls back to the next preferred backend when an agent fails without a payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("codex is not authenticated");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented by fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const { stdout } = await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "codex,claude"
      }
    });

    const output = JSON.parse(stdout);
    const result = JSON.parse(await readFile(resultPath, "utf8"));

    assert.equal(output.status, "fixed");
    assert.equal(result.summary, "implemented by fallback");
  });

  it("returns aggregated attempt output when all preferred backends fail without a payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("codex failed");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.error("claude failed");
process.exit(1);
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    await assert.rejects(
      spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          KAIZEN_BUILD_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: dir,
          KAIZEN_PREFERRED_AGENT: "codex,claude"
        }
      }),
      /Command exited with 2/
    );

    const result = JSON.parse(await readFile(resultPath, "utf8"));

    assert.equal(result.status, "blocked");
    assert.equal(result.summary, "Builder agent exited with code 1.");
    assert.match(result.notes, /Agent "codex" exited with code 1/);
    assert.match(result.notes, /codex failed/);
    assert.match(result.notes, /Agent "claude" exited with code 1/);
    assert.match(result.notes, /claude failed/);
  });

  it("runs custom providers from KAIZEN_AGENT_PROVIDERS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    const argsPath = join(dir, "opencode-args.json");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeOpenCodePath = join(binDir, "opencode-go");

    await writeFile(
      fakeOpenCodePath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
console.log(JSON.stringify({
  status: "fixed",
  summary: "implemented by custom provider",
  notes: "checked"
}));
})();
`,
      "utf8"
    );
    await chmod(fakeOpenCodePath, 0o755);

    const { stdout } = await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "opencode-go",
        KAIZEN_AGENT_MODEL: "zai-coder",
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          "opencode-go": {
            command: "opencode-go",
            args: ["run", "--cwd", "{{workspaceDir}}", "--model", "{{model}}", "{{prompt}}"],
            output: "stdout"
          }
        })
      }
    });

    const output = JSON.parse(stdout);
    const args = JSON.parse(await readFile(argsPath, "utf8"));

    assert.equal(output.status, "fixed");
    assert.equal(output.summary, "implemented by custom provider");
    assert.deepEqual(args, ["run", "--cwd", dir, "--model", "zai-coder", "Fix issue #1"]);
  });

  it("omits custom provider flag-value pairs when a placeholder value is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    const argsPath = join(dir, "zai-args.json");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeZaiPath = join(binDir, "zai");

    await writeFile(
      fakeZaiPath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
console.log(JSON.stringify({
  status: "fixed",
  summary: "implemented without model",
  notes: "checked"
}));
})();
`,
      "utf8"
    );
    await chmod(fakeZaiPath, 0o755);

    await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "zai",
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          zai: {
            command: "zai",
            args: ["agent", "--workspace", "{{workspaceDir}}", "--model", "{{model}}", "{{prompt}}"],
            output: "stdout"
          }
        })
      }
    });

    const args = JSON.parse(await readFile(argsPath, "utf8"));

    assert.deepEqual(args, ["agent", "--workspace", dir, "Fix issue #1"]);
  });

  it("loads custom providers from KAIZEN_AGENT_PROVIDERS_FILE and applies prompt templates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    const argsPath = join(dir, "hermes-args.json");
    const providerConfigPath = join(dir, "providers.json");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeHermesPath = join(binDir, "hermes-agent");

    await writeFile(
      fakeHermesPath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
console.log(JSON.stringify({
  status: "fixed",
  summary: "implemented by hermes-style provider",
  notes: "checked"
}));
})();
`,
      "utf8"
    );
    await writeFile(
      providerConfigPath,
      JSON.stringify({
        providers: {
          "hermes-agent": {
            command: "hermes-agent",
            args: ["run", "--input", "{{prompt}}"],
            promptTemplate: "Hermes task:\n{{prompt}}",
            output: "stdout"
          }
        }
      }),
      "utf8"
    );
    await chmod(fakeHermesPath, 0o755);

    const { stdout } = await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "hermes-agent",
        KAIZEN_AGENT_PROVIDERS_FILE: providerConfigPath
      }
    });

    const output = JSON.parse(stdout);
    const args = JSON.parse(await readFile(argsPath, "utf8"));

    assert.equal(output.status, "fixed");
    assert.equal(output.summary, "implemented by hermes-style provider");
    assert.deepEqual(args, ["run", "--input", "Hermes task:\nFix issue #1"]);
  });

  it("falls back when a provider health check fails with a fallbackable class", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeHermesPath = join(binDir, "hermes-agent");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeHermesPath,
      `#!/usr/bin/env node
if (process.argv[2] === "health") {
  console.error("401 unauthorized");
  process.exit(1);
}
console.log(JSON.stringify({
  status: "fixed",
  summary: "primary should not run",
  notes: "checked"
}));
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented after health-check fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeHermesPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const { stdout } = await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "hermes-agent,claude",
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          "hermes-agent": {
            command: "hermes-agent",
            args: ["run", "{{prompt}}"],
            healthCheck: { args: ["health"] },
            output: "stdout"
          }
        })
      }
    });

    const output = JSON.parse(stdout);
    const result = JSON.parse(await readFile(resultPath, "utf8"));

    assert.equal(output.status, "fixed");
    assert.equal(result.summary, "implemented after health-check fallback");
    assert.match(result.notes, /Provider evidence/);
    assert.match(result.notes, /hermes-agent: exitCode=1, status=fallback, failureClass=auth_failed/);
    assert.match(result.notes, /Selected backend: claude/);
  });

  it("stops fallback for provider-blocked failures unless the provider opts in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("content policy safety refusal");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"should not fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    await assert.rejects(
      spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          KAIZEN_BUILD_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: dir,
          KAIZEN_PREFERRED_AGENT: "codex,claude"
        }
      }),
      /Command exited with 2/
    );

    const result = JSON.parse(await readFile(resultPath, "utf8"));

    assert.equal(result.status, "blocked");
    assert.equal(result.summary, "Builder agent exited with code 1.");
    assert.match(result.notes, /Failure class: provider_blocked/);
    assert.doesNotMatch(result.notes, /should not fallback/);
  });

  it("falls back when a provider emits an unrelated safety log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeCodexPath = join(binDir, "codex");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
console.error("project safety check failed");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"fallback after project safety check\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "codex,claude"
      }
    });

    const result = JSON.parse(await readFile(resultPath, "utf8"));

    assert.equal(result.status, "fixed");
    assert.equal(result.summary, "fallback after project safety check");
    assert.match(result.notes, /codex: exitCode=1, status=fallback, failureClass=invalid_payload/);
    assert.match(result.notes, /Selected backend: claude/);
  });

  it("falls back on provider-blocked failures when the provider opts in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeHermesPath = join(binDir, "hermes-agent");
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeHermesPath,
      `#!/usr/bin/env node
console.error("provider blocked by content policy");
process.exit(1);
`,
      "utf8"
    );
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented after provider-blocked fallback\",\"notes\":\"checked\"}\n```")}
}));
`,
      "utf8"
    );
    await chmod(fakeHermesPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    await spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: resultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "hermes-agent,claude",
        KAIZEN_AGENT_PROVIDERS: JSON.stringify({
          "hermes-agent": {
            command: "hermes-agent",
            args: ["run", "{{prompt}}"],
            fallbackOn: ["provider_blocked"],
            output: "stdout"
          }
        })
      }
    });

    const result = JSON.parse(await readFile(resultPath, "utf8"));

    assert.equal(result.status, "fixed");
    assert.equal(result.summary, "implemented after provider-blocked fallback");
    assert.match(result.notes, /hermes-agent: exitCode=1, status=fallback, failureClass=provider_blocked, fallbackReason=provider_blocked/);
    assert.match(result.notes, /claude: exitCode=0, status=selected, failureClass=none, fallbackReason=none/);
    assert.match(result.notes, /Selected backend: claude/);
    assert.match(result.notes, /Final payload source: stdout/);
  });

  it("preserves structured blocked payloads when the codex backend exits non-zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), '{"type":"module"}', "utf8");
    const fakeCodexPath = join(binDir, "codex");

    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output-last-message");
writeFileSync(args[outputIndex + 1], JSON.stringify({
  status: "blocked",
  summary: "provider reported a structured block",
  notes: "captured provider detail",
  blockedReason: "provider limit reached",
  discoveredIssues: [{ title: "Provider limit", severity: "medium" }]
}));
process.exit(2);
})();
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);

    await assert.rejects(
      spawnWithInput(process.execPath, ["src/cli.js"], "Fix issue #1", {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          KAIZEN_BUILD_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: dir,
          KAIZEN_PREFERRED_AGENT: "codex"
        }
      }),
      /Command exited with 2/
    );

    const result = JSON.parse(await readFile(resultPath, "utf8"));

    assert.equal(result.status, "blocked");
    assert.equal(result.summary, "provider reported a structured block");
    assert.equal(result.notes, "captured provider detail");
    assert.equal(result.blockedReason, "provider limit reached");
    assert.deepEqual(result.discoveredIssues, [{ title: "Provider limit", severity: "medium" }]);
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
