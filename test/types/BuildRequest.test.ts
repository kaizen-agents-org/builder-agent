import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAgent, normalizeAgents, normalizeBuildRequest } from "../../dist/index.js";

describe("BuildRequest", () => {
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
    assert.deepEqual(normalizeAgents(" , \n\t "), ["codex", "claude"]);
    assert.equal(normalizeAgent(undefined), "codex");
  });

  it("honors explicit custom provider fallback order exactly", () => {
    assert.deepEqual(normalizeAgents("opencode-go"), ["opencode-go"]);
    assert.deepEqual(normalizeAgents("opencode-go,codex,claude"), ["opencode-go", "codex", "claude"]);
  });

  it("rejects unknown build request fields", () => {
    assert.throws(
      () => normalizeBuildRequest({ task: "Do work.", extra: true }),
      /unknown field/
    );
  });

  it("rejects whitespace-only request strings", () => {
    assert.throws(
      () => normalizeBuildRequest({ task: " \n\t " }),
      /requires a non-empty task/
    );
    assert.throws(
      () => normalizeBuildRequest({ task: "Do work.", goal: " \n\t " }),
      /goal must be a non-empty string/
    );
    assert.throws(
      () => normalizeBuildRequest({ task: "Do work.", constraints: [" \n\t "] }),
      /constraints must be an array of non-empty strings/
    );
  });
});
