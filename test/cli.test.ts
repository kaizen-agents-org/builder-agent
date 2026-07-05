import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { failingReview, passingReview, spawnWithInput } from "./helpers.ts";

const execFileAsync = promisify(execFile);

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
      "dist/cli.js",
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
    assert.deepEqual(result.taskUnderstanding, {
      summary: "Task: Implement a small feature.",
      constraints: []
    });
    assert.equal(review.passed, true);
  });

  it("supports the kaizen-loop stdin/result-file contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    const argsPath = join(dir, "claude-args.json");
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
(async () => {
const { writeFileSync } = await import("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented\",\"notes\":\"checked\",\"discoveredIssues\":[{\"title\":\"Verifier false positive\",\"repo\":\"verifier\",\"evidence\":\"log excerpt\"}]}\n```")}
}));
})();
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const { stdout } = await spawnWithInput(process.execPath, ["dist/cli.js"], "Fix issue #1", {
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
    const args = JSON.parse(await readFile(argsPath, "utf8"));
    const allowedToolsIndex = args.indexOf("--allowedTools");
    assert.notEqual(allowedToolsIndex, -1);
    const allowedTools = args[allowedToolsIndex + 1];

    assert.equal(output.status, "fixed");
    assert.equal(result.status, "fixed");
    assert.equal(result.summary, "implemented");
    assert.doesNotMatch(allowedTools, /Bash\(git add:\*\)/);
    assert.doesNotMatch(allowedTools, /Bash\(git commit:\*\)/);
    assert.match(allowedTools, /Bash\(npm:\*\)/);
    assert.match(allowedTools, /\bRead\b/);
    assert.match(allowedTools, /\bWrite\b/);
    assert.match(allowedTools, /\bEdit\b/);
    assert.match(allowedTools, /\bGlob\b/);
    assert.match(allowedTools, /\bGrep\b/);
    assert.deepEqual(result.discoveredIssues, [
      {
        title: "Verifier false positive",
        repo: "verifier",
        evidence: "log excerpt"
      }
    ]);
  });

  it("returns exit code 2 for blocked build results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const requestPath = join(dir, "request.json");
    const adapterPath = join(dir, "adapter.mjs");

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
    return ${JSON.stringify(failingReview)};
  },
  async improve() {
    throw new Error("improve should not be called");
  }
};
`,
      "utf8"
    );

    await assert.rejects(
      execFileAsync(process.execPath, [
        "dist/cli.js",
        "build",
        "--request",
        requestPath,
        "--adapter",
        adapterPath,
        "--out",
        join(dir, "out")
      ]),
      (error) => error.code === 2 && /"status": "blocked"/.test(error.stdout)
    );
  });

  it("returns exit code 3 for command parsing errors", async () => {
    await assert.rejects(
      execFileAsync(process.execPath, ["dist/cli.js", "unknown-command"]),
      (error) => error.code === 3 && /Unknown command: unknown-command/.test(error.stderr)
    );
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
      spawnWithInput(process.execPath, ["dist/cli.js"], "Fix issue #1", {
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

    await spawnWithInput(process.execPath, ["dist/cli.js"], "Fix issue #1", {
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
