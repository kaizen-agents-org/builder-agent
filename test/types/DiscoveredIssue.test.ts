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
      () => normalizeDiscoveredIssues([{ repo: "verifier" }], { label: "discoveredIssues" }),
      /discoveredIssues\[0\]\.title/
    );
  });
});
