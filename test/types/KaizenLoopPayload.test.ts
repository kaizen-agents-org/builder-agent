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
