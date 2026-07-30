import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { failingReview, passingReview, spawnWithInput } from "./helpers.ts";

const execFileAsync = promisify(execFile);

describe("CLI", () => {
  it("reports the version from package metadata", async () => {
    const packageMetadata = JSON.parse(await readFile("package.json", "utf8")) as { version: string };

    for (const flag of ["--version", "-v"]) {
      const { stdout } = await execFileAsync(process.execPath, ["dist/cli.js", flag]);
      assert.equal(stdout.trim(), `builder-agent ${packageMetadata.version}`);
    }
  });

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
    const launchDir = await mkdtemp(join(tmpdir(), "builder-agent-launch-"));
    const binDir = join(dir, "bin");
    const relativeResultPath = join(".kaizen", "builder", "build-result.json");
    const resultPath = join(dir, relativeResultPath);
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
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented\",\"notes\":\"checked\",\"discoveredIssues\":[{\"title\":\"Verifier false positive\",\"repo\":\"verifier\",\"expected\":\"Verifier should pass valid runs.\",\"evidence\":\"log excerpt\"}]}\n```")}
}));
})();
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);
    await chmod(fakeClaudePath, 0o755);

    const { stdout } = await spawnWithInput(process.execPath, [join(process.cwd(), "dist", "cli.js")], "Fix issue #1", {
      cwd: launchDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KAIZEN_BUILD_RESULT_PATH: relativeResultPath,
        KAIZEN_WORKSPACE_DIR: dir,
        KAIZEN_PREFERRED_AGENT: "claude"
      }
    });

    const output = JSON.parse(stdout);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    const args = JSON.parse(await readFile(argsPath, "utf8"));
    const permissionModeIndex = args.indexOf("--permission-mode");
    const allowedToolsIndex = args.indexOf("--allowedTools");
    assert.notEqual(permissionModeIndex, -1);
    assert.notEqual(allowedToolsIndex, -1);
    const allowedTools = args[allowedToolsIndex + 1];

    assert.equal(output.status, "fixed");
    assert.equal(result.status, "fixed");
    assert.equal(result.summary, "implemented");
    assert.equal(args[permissionModeIndex + 1], "dontAsk");
    assert.doesNotMatch(allowedTools, /Bash\(git add:\*\)/);
    assert.doesNotMatch(allowedTools, /Bash\(git commit:\*\)/);
    assert.doesNotMatch(allowedTools, /Bash\(git push:\*\)/);
    assert.doesNotMatch(allowedTools, /Bash\(gh:\*\)/);
    assert.doesNotMatch(allowedTools, /Bash\((?:npm|pnpm|yarn):\*\)/);
    assert.doesNotMatch(allowedTools, /Bash\((?:node|npx):\*\)/);
    assert.match(allowedTools, /Bash\(npm test:\*\)/);
    assert.match(allowedTools, /Bash\(npm run validate:\*\)/);
    assert.match(allowedTools, /Bash\(pnpm test:\*\)/);
    assert.match(allowedTools, /Bash\(pnpm run lint:\*\)/);
    assert.match(allowedTools, /Bash\(yarn test:\*\)/);
    assert.match(allowedTools, /Bash\(yarn run check:\*\)/);
    assert.match(allowedTools, /\bRead\b/);
    assert.match(allowedTools, /\bWrite\b/);
    assert.match(allowedTools, /\bEdit\b/);
    assert.match(allowedTools, /\bGlob\b/);
    assert.match(allowedTools, /\bGrep\b/);
    assert.deepEqual(result.discoveredIssues, [
      {
        title: "Verifier false positive",
        repo: "verifier",
        expected: "Verifier should pass valid runs.",
        evidence: "log excerpt"
      }
    ]);
  });

  it("rejects kaizen-loop result paths outside the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const workspaceDir = join(dir, "workspace");
    await mkdir(workspaceDir);

    for (const [configuredResultPath, escapedResultPath] of [
      ["../escaped-relative.json", join(dir, "escaped-relative.json")],
      [join(dir, "escaped-absolute.json"), join(dir, "escaped-absolute.json")]
    ]) {
      await assert.rejects(
        spawnWithInput(process.execPath, ["dist/cli.js"], "Fix issue #1", {
          env: {
            ...process.env,
            KAIZEN_BUILD_RESULT_PATH: configuredResultPath,
            KAIZEN_WORKSPACE_DIR: workspaceDir
          }
        }),
        /KAIZEN_BUILD_RESULT_PATH must resolve to a file inside KAIZEN_WORKSPACE_DIR/
      );
      await assert.rejects(readFile(escapedResultPath, "utf8"), { code: "ENOENT" });
    }
  });

  it("does not follow symlinks when writing the kaizen-loop result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const workspaceDir = join(dir, "workspace");
    const outsideDir = join(dir, "outside");
    const binDir = join(dir, "bin");
    await mkdir(workspaceDir);
    await mkdir(outsideDir);
    await mkdir(binDir);

    for (const resultPathKind of ["parent", "file"]) {
      const resultPath =
        resultPathKind === "parent"
          ? join(workspaceDir, "linked", "build-result.json")
          : join(workspaceDir, "build-result.json");
      const escapedResultPath = join(outsideDir, `${resultPathKind}-result.json`);
      const fakeClaudePath = join(binDir, `claude-${resultPathKind}`);

      await writeFile(escapedResultPath, "do not overwrite", "utf8");
      await writeFile(
        fakeClaudePath,
        `#!/usr/bin/env node
import { rmSync, symlinkSync } from "node:fs";
rmSync(${JSON.stringify(resultPathKind === "parent" ? join(workspaceDir, "linked") : resultPath)}, { force: true, recursive: true });
symlinkSync(
  ${JSON.stringify(resultPathKind === "parent" ? outsideDir : escapedResultPath)},
  ${JSON.stringify(resultPathKind === "parent" ? join(workspaceDir, "linked") : resultPath)},
  ${JSON.stringify(resultPathKind === "parent" ? "dir" : "file")}
);
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented\",\"notes\":\"checked\"}\n```")}
}));
`,
        "utf8"
      );
      await chmod(fakeClaudePath, 0o755);
      await symlink(fakeClaudePath, join(binDir, "claude"));

      await assert.rejects(
        spawnWithInput(process.execPath, ["dist/cli.js"], "Fix issue #1", {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            KAIZEN_BUILD_RESULT_PATH: resultPath,
            KAIZEN_WORKSPACE_DIR: workspaceDir,
            KAIZEN_PREFERRED_AGENT: "claude"
          }
        }),
        /KAIZEN_BUILD_RESULT_PATH must resolve to a file inside KAIZEN_WORKSPACE_DIR/
      );
      assert.equal(await readFile(escapedResultPath, "utf8"), "do not overwrite");
      await unlink(join(binDir, "claude"));
    }
  });

  it("does not overwrite a hard-linked file outside the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const workspaceDir = join(dir, "workspace");
    const resultPath = join(workspaceDir, "result.json");
    const externalPath = join(dir, "external.json");
    await mkdir(workspaceDir);
    await writeFile(externalPath, "do not overwrite", "utf8");
    await link(externalPath, resultPath);

    await assert.rejects(
      spawnWithInput(process.execPath, ["dist/cli.js"], "Fix issue #1", {
        env: {
          ...process.env,
          KAIZEN_BUILD_RESULT_PATH: resultPath,
          KAIZEN_WORKSPACE_DIR: workspaceDir
        }
      }),
      /KAIZEN_BUILD_RESULT_PATH must resolve to a file inside KAIZEN_WORKSPACE_DIR/
    );
    assert.equal(await readFile(externalPath, "utf8"), "do not overwrite");
  });

  it("returns exit code 0 for partial kaizen-loop payloads so verifier gates PR readiness", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeClaudePath = join(binDir, "claude");
    const partialNotes = "Completed scope: updated docs. Incomplete scope: provider rollout remains. Verification: npm test ran. Residual risk: verifier may reject the caveat.";
    const partialPayload = JSON.stringify({
      status: "partial",
      summary: "implemented reviewable subset",
      notes: partialNotes
    });

    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify(`\`\`\`json\n${partialPayload}\n\`\`\``)}
}));
`,
      "utf8"
    );
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

    assert.equal(output.status, "partial");
    assert.equal(result.status, "partial");
    assert.equal(result.summary, "implemented reviewable subset");
    assert.match(result.notes, /Completed scope: updated docs/);
    assert.match(result.notes, /Provider evidence:/);
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

  it("preserves valid discovered issues from malformed kaizen-loop provider payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented\",\"discoveredIssues\":[{\"title\":\"Verifier false positive\",\"repo\":\"verifier\",\"expected\":\"Verifier should pass valid runs.\",\"evidence\":\"verifier.log\"}]}\n```")}
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
    assert.equal(result.summary, "Builder agent did not return the required Kaizen Loop JSON payload.");
    assert.match(result.notes, /Agent "claude" exited with code 0/);
    assert.match(result.notes, /Failure class: invalid_payload/);
    assert.deepEqual(result.discoveredIssues, [{
      title: "Verifier false positive",
      repo: "verifier",
      expected: "Verifier should pass valid runs.",
      evidence: "verifier.log"
    }]);
  });

  it("preserves valid discovered issues alongside malformed entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "builder-agent-"));
    const binDir = join(dir, "bin");
    const resultPath = join(dir, "build-result.json");
    await mkdir(binDir);
    const fakeClaudePath = join(binDir, "claude");

    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  result: ${JSON.stringify("```json\n{\"status\":\"fixed\",\"summary\":\"implemented\",\"notes\":\"checked\",\"discoveredIssues\":[{\"repo\":\"verifier\"},{\"title\":\"Verifier false positive\",\"repo\":\"verifier\",\"expected\":\"Verifier should pass valid runs.\",\"evidence\":\"verifier.log\"}]}\n```")}
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
    assert.deepEqual(result.discoveredIssues, [{
      title: "Verifier false positive",
      repo: "verifier",
      expected: "Verifier should pass valid runs.",
      evidence: "verifier.log"
    }]);
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
