import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { normalizeKaizenLoopPayload } from "../../dist/index.js";

describe("KaizenLoopPayload", () => {
  it("normalizes kaizen-loop payloads with the published schema shape", () => {
    const payload = normalizeKaizenLoopPayload({
      status: "partial",
      summary: "  Implemented most of the change.  ",
      notes: "Completed scope: schema docs. Incomplete scope: provider rollout. Verification: ran targeted checks. Residual risk: downstream verifier may still block.",
      discoveredIssues: [
        {
          title: "  Missing verifier diagnostic  ",
          repo: " verifier ",
          expected: "  The verifier should include the diagnostic.  ",
          evidence: "  verifier.log  ",
          labels: ["kaizen", "kaizen"]
        }
      ]
    });

    assert.deepEqual(payload, {
      status: "partial",
      summary: "Implemented most of the change.",
      notes: "Completed scope: schema docs. Incomplete scope: provider rollout. Verification: ran targeted checks. Residual risk: downstream verifier may still block.",
      discoveredIssues: [
        {
          title: "Missing verifier diagnostic",
          repo: "verifier",
          expected: "The verifier should include the diagnostic.",
          evidence: "verifier.log",
          labels: ["kaizen"]
        }
      ]
    });
  });

  it("rejects empty kaizen-loop payload summaries", () => {
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "fixed",
        summary: "",
        notes: ""
      }),
      /summary must be a non-empty string/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "fixed",
        summary: "   \n\t  ",
        notes: ""
      }),
      /summary must be a non-empty string/
    );
  });

  it("requires partial payload notes to document the completion caveat", () => {
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "partial",
        summary: "Some reviewable code was produced.",
        notes: ""
      }),
      /notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "partial",
        summary: "Some reviewable code was produced.",
        notes: "  \n\t  "
      }),
      /notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial/
    );
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
        discoveredIssues: [{ title: "Bad routing", expected: "Route to verifier.", evidence: "payload.json", repo: 123 }]
      }),
      /discoveredIssues\[0\]\.repo must be a string/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "fixed",
        summary: "Implemented.",
        notes: "",
        discoveredIssues: [{ title: "Title-only follow-up" }]
      }),
      /discoveredIssues\[0\]\.expected must be a non-empty string/
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

  it("requires blockedReason only for blocked kaizen-loop payloads", () => {
    assert.equal(
      normalizeKaizenLoopPayload({
        status: "blocked",
        summary: "Blocked by missing credentials.",
        notes: "Provider could not run.",
        blockedReason: "  Missing ANTHROPIC_API_KEY.  "
      }).blockedReason,
      "Missing ANTHROPIC_API_KEY."
    );

    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "blocked",
        summary: "Blocked.",
        notes: ""
      }),
      /blockedReason must be a non-empty string when status is blocked/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "blocked",
        summary: "Blocked.",
        notes: "",
        blockedReason: "   "
      }),
      /blockedReason must be a non-empty string when status is blocked/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "fixed",
        summary: "Fixed.",
        notes: "",
        blockedReason: "No longer blocked."
      }),
      /blockedReason is only valid when status is blocked/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "partial",
        summary: "Partially fixed.",
        notes: "Completed scope: docs. Incomplete scope: provider rollout. Verification: skipped. Residual risk: verifier may block.",
        blockedReason: "No longer blocked."
      }),
      /blockedReason is only valid when status is blocked/
    );
  });

  it("publishes the kaizen-loop payload schema", async () => {
    const schema = JSON.parse(await readFile("schemas/kaizen-loop-payload.schema.json", "utf8"));

    assert.deepEqual(schema.properties.status.enum, ["fixed", "partial", "blocked"]);
    assert.equal(schema.properties.summary.minLength, 1);
    assert.equal(schema.properties.summary.pattern, "\\S");
    assert.equal(schema.properties.blockedReason.minLength, 1);
    assert.equal(schema.properties.blockedReason.pattern, "\\S");
    assert.equal(schema.allOf.length, 3);
    assert.equal(schema.allOf[2].if.properties.status.const, "partial");
    assert.equal(schema.allOf[2].then.properties.notes.minLength, 1);
    assert.equal(schema.allOf[2].then.properties.notes.pattern, "\\S");
    assert.equal(schema.properties.discoveredIssues.items.properties.repo.type, "string");
    assert.deepEqual(schema.properties.discoveredIssues.items.required, ["title", "expected", "evidence"]);
    assert.equal(schema.properties.discoveredIssues.items.properties.expected.pattern, "\\S");
    assert.equal(schema.properties.discoveredIssues.items.properties.evidence.pattern, "\\S");
    assert.equal(schema.required.includes("discoveredIssues"), false);
    assert.equal(schema.required.includes("blockedReason"), false);
  });
});
