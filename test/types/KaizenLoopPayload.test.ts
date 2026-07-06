import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { normalizeKaizenLoopPayload } from "../../dist/index.js";

describe("KaizenLoopPayload", () => {
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
      summary: "Implemented most of the change.",
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
        notes: "",
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
    assert.equal(schema.allOf.length, 2);
    assert.equal(schema.properties.discoveredIssues.items.properties.repo.type, "string");
    assert.equal(schema.required.includes("discoveredIssues"), false);
    assert.equal(schema.required.includes("blockedReason"), false);
  });
});
