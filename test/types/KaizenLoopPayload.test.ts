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
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "partial",
        summary: "Some reviewable code was produced.",
        notes: "Implemented the schema and ran tests, but provider rollout remains."
      }),
      /notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial/
    );
  });

  it("requires every partial note section to have a value", () => {
    const sections = [
      ["Completed scope", "schema docs"],
      ["Incomplete scope", "provider rollout"],
      ["Verification", "ran targeted checks"],
      ["Residual risk", "downstream verifier may still block"]
    ];

    for (const [missingLabel] of sections) {
      const notes = sections
        .filter(([label]) => label !== missingLabel)
        .map(([label, value]) => `${label}: ${value}.`)
        .join(" ");

      assert.throws(
        () => normalizeKaizenLoopPayload({
          status: "partial",
          summary: "Some reviewable code was produced.",
          notes
        }),
        /notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial/
      );
    }

    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "partial",
        summary: "Some reviewable code was produced.",
        notes: "Completed scope: Incomplete scope: provider rollout. Verification: skipped. Residual risk: verifier may block."
      }),
      /notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial/
    );

    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "partial",
        summary: "Some reviewable code was produced.",
        notes: "- Completed scope:\n- Incomplete scope:\n- Verification:\n- Residual risk: unknown"
      }),
      /notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial/
    );

    for (const notes of [
      "1. Completed scope:\n2. Incomplete scope:\n3. Verification:\n4. Residual risk: unknown",
      "1) Completed scope:\n2) Incomplete scope:\n3) Verification:\n4) Residual risk: unknown",
      "Completed scope: —. Incomplete scope: provider rollout. Verification: ran targeted checks. Residual risk: downstream verifier may still block",
      "Completed scope: schema docs. Incomplete scope: –. Verification: ran targeted checks. Residual risk: downstream verifier may still block",
      "Completed scope:\nCompleted scope: schema docs\nIncomplete scope: provider rollout\nVerification: ran targeted checks\nResidual risk: downstream verifier may still block"
    ]) {
      assert.throws(
        () => normalizeKaizenLoopPayload({
          status: "partial",
          summary: "Some reviewable code was produced.",
          notes
        }),
        /notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial/
      );
    }

    assert.doesNotThrow(() => normalizeKaizenLoopPayload({
      status: "partial",
      summary: "Some reviewable code was produced.",
      notes: "- Completed scope: schema docs\n- Incomplete scope: provider rollout\n- Verification: ran targeted checks\n- Residual risk: downstream verifier may still block"
    }));

    assert.doesNotThrow(() => normalizeKaizenLoopPayload({
      status: "partial",
      summary: "Some reviewable code was produced.",
      notes: "1. Completed scope: schema docs\n2. Incomplete scope: provider rollout\n3. Verification: ran targeted checks\n4. Residual risk: downstream verifier may still block"
    }));
    assert.doesNotThrow(() => normalizeKaizenLoopPayload({
      status: "partial",
      summary: "Some reviewable code was produced.",
      notes: "- **Completed scope:** schema docs\n- **Incomplete scope:** provider rollout\n- **Verification:** ran targeted checks\n- **Residual risk:** downstream verifier may still block"
    }));

    for (const verification of [
      "skipped",
      "SKIPPED",
      "Skipped —",
      "skipped —",
      "skipped - ;",
      "**skipped**",
      "_skipped_",
      "`skipped`",
      "skipped:",
      "SKIPPED:",
      "**skipped**:"
    ]) {
      assert.throws(
        () => normalizeKaizenLoopPayload({
          status: "partial",
          summary: "Some reviewable code was produced.",
          notes: `Completed scope: schema docs. Incomplete scope: provider rollout. Verification: ${verification}. Residual risk: downstream verifier may still block.`
        }),
        /notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial/
      );
    }

    assert.doesNotThrow(() => normalizeKaizenLoopPayload({
      status: "partial",
      summary: "Some reviewable code was produced.",
      notes: "Completed scope: schema docs. Incomplete scope: provider rollout. Verification: skipped — the integration service was unavailable. Residual risk: downstream verifier may still block."
    }));

    for (const verification of ["**skipped** — service unavailable", "_skipped_ - service unavailable", "`skipped` — service unavailable"]) {
      assert.doesNotThrow(() => normalizeKaizenLoopPayload({
        status: "partial",
        summary: "Some reviewable code was produced.",
        notes: `Completed scope: schema docs. Incomplete scope: provider rollout. Verification: ${verification}. Residual risk: downstream verifier may still block.`
      }));
    }
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
        notes: "Completed scope: docs. Incomplete scope: provider rollout. Verification: skipped — integration service unavailable. Residual risk: verifier may block.",
        blockedReason: "No longer blocked."
      }),
      /blockedReason is only valid when status is blocked/
    );
  });

  it("normalizes a structured human request only for blocked payloads", () => {
    assert.deepEqual(
      normalizeKaizenLoopPayload({
        status: "blocked",
        summary: "Production access requires approval.",
        notes: "No production action was attempted.",
        blockedReason: "A maintainer must approve the production rollout.",
        humanRequest: {
          reasonCode: "production_change",
          requestKey: "production-deployment",
          question: "  Approve deploying this change to production?  "
        }
      }).humanRequest,
      {
        reasonCode: "production_change",
        requestKey: "production-deployment",
        question: "Approve deploying this change to production?"
      }
    );

    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "fixed",
        summary: "Fixed.",
        notes: "",
        humanRequest: {
          reasonCode: "production_change",
          requestKey: "production-deployment",
          question: "Approve deployment?"
        }
      }),
      /humanRequest is only valid when status is blocked/
    );
  });

  it("rejects malformed or unsupported human requests", () => {
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "blocked",
        summary: "Blocked.",
        notes: "",
        blockedReason: "Approval required.",
        humanRequest: {
          reasonCode: "unknown_reason",
          requestKey: "approval",
          question: "Approve?"
        }
      }),
      /humanRequest reasonCode/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "blocked",
        summary: "Blocked.",
        notes: "",
        blockedReason: "Approval required.",
        humanRequest: {
          reasonCode: "credentials",
          requestKey: "billing-credentials",
          question: "   "
        }
      }),
      /humanRequest question must be a non-empty string/
    );
    assert.throws(
      () => normalizeKaizenLoopPayload({
        status: "blocked",
        summary: "Blocked.",
        notes: "",
        blockedReason: "Approval required.",
        humanRequest: {
          reasonCode: "credentials",
          requestKey: "Question wording that changes",
          question: "Approve?"
        }
      }),
      /requestKey must be a stable lowercase semantic key/
    );
  });

  it("treats an empty blockedReason on completed payloads as absent", () => {
    const discoveredIssues = [{
      title: "Follow-up issue",
      expected: "Preserve discovered issues during normalization.",
      evidence: "builder output"
    }];

    assert.deepEqual(
      normalizeKaizenLoopPayload({
        status: "fixed",
        summary: "Implemented and verified.",
        notes: "Tests passed.",
        blockedReason: "  \n\t  ",
        discoveredIssues
      }),
      {
        status: "fixed",
        summary: "Implemented and verified.",
        notes: "Tests passed.",
        discoveredIssues
      }
    );
  });

  it("publishes the kaizen-loop payload schema", async () => {
    const schema = JSON.parse(await readFile("schemas/kaizen-loop-payload.schema.json", "utf8"));

    assert.deepEqual(schema.properties.status.enum, ["fixed", "partial", "blocked"]);
    assert.equal(schema.properties.summary.minLength, 1);
    assert.equal(schema.properties.summary.pattern, "\\S");
    assert.equal(schema.allOf[0].then.properties.blockedReason.minLength, 1);
    assert.equal(schema.allOf[0].then.properties.blockedReason.pattern, "\\S");
    assert.equal(schema.allOf[1].then.properties.blockedReason.not.pattern, "\\S");
    assert.equal(schema.allOf.length, 4);
    assert.equal(schema.allOf[2].if.properties.status.const, "partial");
    assert.equal(schema.allOf[2].then.properties.notes.minLength, 1);
    assert.equal(schema.allOf[2].then.properties.notes.pattern, "\\S");
    const duplicatePartialNotePattern = schema.allOf[2].then.properties.notes.not.pattern;
    assert.equal(
      duplicatePartialNotePattern,
      "(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:\\*\\*)?(Completed scope|Incomplete scope|Verification|Residual risk)\\s*:(?:\\*\\*)?[\\s\\S]*(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:\\*\\*)?\\1\\s*:(?:\\*\\*)?"
    );
    const partialNoteRules = schema.allOf[2].then.properties.notes.allOf;
    const partialNotePatterns = partialNoteRules.slice(0, 4)
      .map(({ pattern }: { pattern: string }) => pattern);
    assert.deepEqual(partialNotePatterns, [
      "(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:Completed scope\\s*:|\\*\\*Completed scope\\s*:\\*\\*)(?=(?:(?!(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:(?:Completed scope|Incomplete scope|Verification|Residual risk)\\s*:|\\*\\*(?:Completed scope|Incomplete scope|Verification|Residual risk)\\s*:\\*\\*))[\\s\\S])*?[^\\s.;,:—–\\-_*+|#>])",
      "(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:Incomplete scope\\s*:|\\*\\*Incomplete scope\\s*:\\*\\*)(?=(?:(?!(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:(?:Completed scope|Incomplete scope|Verification|Residual risk)\\s*:|\\*\\*(?:Completed scope|Incomplete scope|Verification|Residual risk)\\s*:\\*\\*))[\\s\\S])*?[^\\s.;,:—–\\-_*+|#>])",
      "(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:Verification\\s*:|\\*\\*Verification\\s*:\\*\\*)(?=(?:(?!(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:(?:Completed scope|Incomplete scope|Verification|Residual risk)\\s*:|\\*\\*(?:Completed scope|Incomplete scope|Verification|Residual risk)\\s*:\\*\\*))[\\s\\S])*?[^\\s.;,:—–\\-_*+|#>])",
      "(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:Residual risk\\s*:|\\*\\*Residual risk\\s*:\\*\\*)(?=(?:(?!(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:(?:Completed scope|Incomplete scope|Verification|Residual risk)\\s*:|\\*\\*(?:Completed scope|Incomplete scope|Verification|Residual risk)\\s*:\\*\\*))[\\s\\S])*?[^\\s.;,:—–\\-_*+|#>])"
    ]);
    const skippedVerificationRule = partialNoteRules[4];
    assert.equal(
      skippedVerificationRule.if.pattern,
      "(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?(?:Verification\\s*:|\\*\\*Verification\\s*:\\*\\*)\\s*(?:[sS][kK][iI][pP][pP][eE][dD]|\\*\\*[sS][kK][iI][pP][pP][eE][dD]\\*\\*|__[sS][kK][iI][pP][pP][eE][dD]__|\\*[sS][kK][iI][pP][pP][eE][dD]\\*|_[sS][kK][iI][pP][pP][eE][dD]_|`[sS][kK][iI][pP][pP][eE][dD]`)(?=$|[\\s.;,:—–-])"
    );
    const matchesPartialNoteSchema = (notes: string) => (
      partialNotePatterns.every((pattern: string) => new RegExp(pattern).test(notes))
      && !new RegExp(duplicatePartialNotePattern).test(notes)
      && (
        !new RegExp(skippedVerificationRule.if.pattern, "i").test(notes)
        || new RegExp(skippedVerificationRule.then.pattern, "i").test(notes)
      )
    );
    assert.equal(
      matchesPartialNoteSchema("- Completed scope:\n- Incomplete scope:\n- Verification:\n- Residual risk: unknown"),
      false
    );
    assert.equal(
      matchesPartialNoteSchema("- Completed scope: schema docs\n- Incomplete scope: provider rollout\n- Verification: ran targeted checks\n- Residual risk: downstream verifier may still block"),
      true
    );
    assert.equal(
      matchesPartialNoteSchema("- **Completed scope:** schema docs\n- **Incomplete scope:** provider rollout\n- **Verification:** ran targeted checks\n- **Residual risk:** downstream verifier may still block"),
      true
    );
    assert.equal(
      matchesPartialNoteSchema("1. Completed scope:\n2. Incomplete scope:\n3. Verification:\n4. Residual risk: unknown"),
      false
    );
    assert.equal(
      matchesPartialNoteSchema("1) Completed scope:\n2) Incomplete scope:\n3) Verification:\n4) Residual risk: unknown"),
      false
    );
    assert.equal(
      matchesPartialNoteSchema("1. Completed scope: schema docs\n2. Incomplete scope: provider rollout\n3. Verification: ran targeted checks\n4. Residual risk: downstream verifier may still block"),
      true
    );
    assert.equal(
      matchesPartialNoteSchema("Completed scope:\nCompleted scope: schema docs\nIncomplete scope: provider rollout\nVerification: ran targeted checks\nResidual risk: downstream verifier may still block"),
      false
    );
    assert.equal(
      matchesPartialNoteSchema("Completed scope: schema docs. Incomplete scope: provider rollout. Verification: skipped. Residual risk: verifier may block."),
      false
    );
    assert.equal(
      matchesPartialNoteSchema("Completed scope: schema docs. Incomplete scope: provider rollout. Verification: SKIPPED. Residual risk: verifier may block."),
      false
    );
    assert.equal(
      matchesPartialNoteSchema("- Completed scope: schema docs\n- Incomplete scope: provider rollout\n- Verification: skipped\n- Residual risk: verifier may block"),
      false
    );
    assert.equal(
      matchesPartialNoteSchema("Completed scope: docs. Verification: skipped - Incomplete scope: rollout. Residual risk: low."),
      false
    );
    for (const verification of ["**skipped**", "_skipped_", "`skipped`", "skipped:", "SKIPPED:", "**skipped**:"]) {
      assert.equal(
        matchesPartialNoteSchema(`Completed scope: schema docs. Incomplete scope: provider rollout. Verification: ${verification}. Residual risk: verifier may block.`),
        false
      );
    }
    assert.equal(
      matchesPartialNoteSchema("Completed scope: —. Incomplete scope: provider rollout. Verification: ran tests. Residual risk: verifier may block."),
      false
    );
    assert.equal(
      matchesPartialNoteSchema("Completed scope: schema docs. Incomplete scope: provider rollout. Verification: skipped — service unavailable. Residual risk: verifier may block."),
      true
    );
    for (const verification of ["**skipped** — service unavailable", "_skipped_ - service unavailable", "`skipped` — service unavailable"]) {
      assert.equal(
        matchesPartialNoteSchema(`Completed scope: schema docs. Incomplete scope: provider rollout. Verification: ${verification}. Residual risk: verifier may block.`),
        true
      );
    }
    assert.equal(schema.properties.discoveredIssues.items.properties.repo.type, "string");
    assert.deepEqual(schema.properties.discoveredIssues.items.required, ["title", "expected", "evidence"]);
    assert.equal(schema.properties.discoveredIssues.items.properties.expected.pattern, "\\S");
    assert.equal(schema.properties.discoveredIssues.items.properties.evidence.pattern, "\\S");
    assert.equal(schema.required.includes("discoveredIssues"), false);
    assert.equal(schema.required.includes("blockedReason"), false);
    assert.equal(schema.required.includes("humanRequest"), false);
    assert.deepEqual(schema.properties.humanRequest.required, ["reasonCode", "requestKey", "question"]);
    assert.deepEqual(schema.properties.humanRequest.properties.reasonCode.enum, [
      "missing_information",
      "credentials",
      "billing",
      "destructive_action",
      "production_change",
      "policy_exception",
      "external_repository_action",
      "other_approval"
    ]);
  });
});
