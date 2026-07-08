import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDiscoveredIssues } from "../../dist/index.js";

describe("DiscoveredIssue", () => {
  it("normalizes discovered issue text fields and labels", () => {
    assert.deepEqual(
      normalizeDiscoveredIssues(
        [
          {
            title: "  Verifier false-positive on legacy status text  ",
            repo: " verifier ",
            body: "  Observed during the run.  ",
            expected: "  The verifier should ignore plain status words in summaries.  ",
            evidence: "  verifier.log  ",
            severity: " P2 ",
            labels: ["kaizen", "kaizen", " follow-up "]
          }
        ],
        { label: "discoveredIssues" }
      ),
      [
        {
          title: "Verifier false-positive on legacy status text",
          repo: "verifier",
          body: "Observed during the run.",
          expected: "The verifier should ignore plain status words in summaries.",
          evidence: "verifier.log",
          severity: "P2",
          labels: ["kaizen", "follow-up"]
        }
      ]
    );
  });

  it("requires each discovered issue title to be present", () => {
    assert.throws(
      () => normalizeDiscoveredIssues([{ repo: "verifier", expected: "Expected behavior.", evidence: "Observed log." }], { label: "discoveredIssues" }),
      /discoveredIssues\[0\]\.title/
    );
  });

  it("requires actionable expected behavior and evidence", () => {
    assert.throws(
      () => normalizeDiscoveredIssues([{ title: "Missing evidence", evidence: "Observed log." }], { label: "discoveredIssues" }),
      /discoveredIssues\[0\]\.expected must be a non-empty string/
    );
    assert.throws(
      () => normalizeDiscoveredIssues([{ title: "Missing evidence", expected: "Expected behavior." }], { label: "discoveredIssues" }),
      /discoveredIssues\[0\]\.evidence must be a non-empty string/
    );
    assert.throws(
      () => normalizeDiscoveredIssues([{ title: "Title only follow-up" }], { label: "discoveredIssues" }),
      /discoveredIssues\[0\]\.expected must be a non-empty string/
    );
  });
});
