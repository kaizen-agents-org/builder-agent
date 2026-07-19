import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { describe, it } from "node:test";
import { listFiles } from "../helpers.ts";

describe("TypeScript build boundaries", () => {
  it("keeps source modules in TypeScript", async () => {
    const sourceFiles = await listFiles("src");

    assert.equal(sourceFiles.some((file) => file.endsWith(".js")), false);
    assert.equal(sourceFiles.some((file) => file.endsWith(".ts")), true);
  });

  it("emits declarations for reusable builder contracts and runners", async () => {
    const [packageJsonText, entrypoint, contracts, buildRequest, kaizenLoopPayload, builderAgent, agentRunner, kaizenLoop, cli, cliStat] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("dist/index.d.ts", "utf8"),
      readFile("dist/types/contracts.d.ts", "utf8"),
      readFile("dist/types/BuildRequest.d.ts", "utf8"),
      readFile("dist/types/KaizenLoopPayload.d.ts", "utf8"),
      readFile("dist/builder/BuilderAgent.d.ts", "utf8"),
      readFile("dist/agents/AgentRunner.d.ts", "utf8"),
      readFile("dist/kaizen-loop.d.ts", "utf8"),
      readFile("dist/cli.js", "utf8"),
      stat("dist/cli.js")
    ]);
    const packageJson = JSON.parse(packageJsonText);

    assert.equal(packageJson.main, "./dist/index.js");
    assert.equal(packageJson.bin["builder-agent"], "./dist/cli.js");
    assert.equal(packageJson.types, "./dist/index.d.ts");
    assert.match(cli, /^#!\/usr\/bin\/env node/);
    assert.notEqual(cliStat.mode & 0o111, 0);
    assert.match(entrypoint, /export type \{[^}]*BuildRequest[^}]*BuilderAdapter[^}]*\} from "\.\/types\/contracts\.js"/);
    assert.match(contracts, /export interface BuilderAdapter/);
    assert.match(contracts, /export interface TaskUnderstanding/);
    assert.match(contracts, /export interface VerificationEvidence/);
    assert.match(contracts, /verification: VerificationEvidence\[\]/);
    assert.match(contracts, /taskUnderstanding: TaskUnderstanding/);
    assert.match(entrypoint, /VerificationEvidence/);
    assert.match(contracts, /export interface KaizenLoopPayload/);
    assert.match(buildRequest, /normalizeBuildRequest\(input: BuildRequestInput\): BuildRequest/);
    assert.match(kaizenLoopPayload, /normalizeKaizenLoopPayload\(input: unknown\): KaizenLoopPayload/);
    assert.match(builderAgent, /build\(input: BuildRequestInput\): Promise<BuildResult>/);
    assert.match(agentRunner, /runImplementationAgent\([^)]*AgentRunInput[^)]*\): Promise<AgentRunResult>/);
    assert.match(kaizenLoop, /runKaizenLoopBuilder\([^)]*KaizenLoopBuilderIO[^)]*\): Promise<KaizenLoopPayload>/);
  });
});

describe("builder handoff contract", () => {
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

  it("keeps discovered issues in a schema-valid Kaizen Loop handoff", async () => {
    const [skill, implementationPrompt] = await Promise.all([
      readFile("SKILL.md", "utf8"),
      readFile("prompts/implement.md", "utf8")
    ]);

    for (const content of [skill, implementationPrompt]) {
      assert.match(content, /blockedReason.*only when.*status.*blocked/is);
      assert.match(content, /omit.*fixed.*partial/is);
      assert.match(content, /humanRequest.*concrete.*human.*question|humanRequest.*concrete unanswered human/is);
      assert.match(content, /empty string|`""`/i);
      assert.match(content, /\.kaizen\/builder\/discovered-issues\.json/);
    }
  });
});
