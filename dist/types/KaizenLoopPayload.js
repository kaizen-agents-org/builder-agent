const STATUS_VALUES = new Set(["fixed", "partial", "blocked"]);
const PAYLOAD_KEYS = new Set(["status", "summary", "notes", "blockedReason", "humanRequest", "discoveredIssues"]);
const PARTIAL_NOTE_LABELS = ["Completed scope", "Incomplete scope", "Verification", "Residual risk"];
const FIXED_NOTE_LABELS = ["Verification", "Residual risk"];
const PARTIAL_NOTE_PREFIX_PATTERN = "(?:^|[\\s.;])(?:(?:[-*+]|\\d+[.)])\\s+)?";
const partialNoteSectionPattern = (labelPattern) => `(?:${labelPattern}\\s*:|\\*\\*${labelPattern}\\s*:\\*\\*)`;
const MEANINGFUL_NOTE_CONTENT = /[^\s.;,:—–\-_*+|#>]/;
const SKIPPED_VERIFICATION = /^(?:skipped|\*\*skipped\*\*|__skipped__|\*skipped\*|_skipped_|`skipped`)(?=$|[\s.;,:—–-])/i;
const SKIPPED_VERIFICATION_WITH_REASON = /^(?:skipped|\*\*skipped\*\*|__skipped__|\*skipped\*|_skipped_|`skipped`)[ \t]*[—–-][ \t]*([\s\S]*)$/i;
const HUMAN_REQUEST_REASON_CODES = new Set([
    "missing_information",
    "credentials",
    "billing",
    "destructive_action",
    "production_change",
    "policy_exception",
    "external_repository_action",
    "other_approval"
]);
import { normalizeDiscoveredIssues as normalizeSharedDiscoveredIssues } from "./DiscoveredIssue.js";
export function normalizeKaizenLoopPayload(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Kaizen Loop payload must be an object.");
    }
    assertAllowedKeys(input, PAYLOAD_KEYS, "Kaizen Loop payload");
    const payload = input;
    if (!isKaizenLoopStatus(payload.status)) {
        throw new Error(`Invalid Kaizen Loop payload status: ${String(payload.status)}`);
    }
    if (typeof payload.summary !== "string") {
        throw new Error("Kaizen Loop payload summary must be a string.");
    }
    const summary = payload.summary.trim();
    if (summary.length === 0) {
        throw new Error("Kaizen Loop payload summary must be a non-empty string.");
    }
    if (typeof payload.notes !== "string") {
        throw new Error("Kaizen Loop payload notes must be a string.");
    }
    if (payload.status === "partial" && !hasStructuredPartialNotes(payload.notes)) {
        throw new Error("Kaizen Loop payload notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial.");
    }
    if (payload.status === "fixed" && !hasStructuredNotes(payload.notes, FIXED_NOTE_LABELS)) {
        throw new Error("Kaizen Loop payload notes must describe verification status and residual risk when status is fixed.");
    }
    if (payload.blockedReason !== undefined && typeof payload.blockedReason !== "string") {
        throw new Error("Kaizen Loop payload blockedReason must be a string.");
    }
    const blockedReason = typeof payload.blockedReason === "string" ? payload.blockedReason.trim() : undefined;
    if (payload.status === "blocked") {
        if (!blockedReason) {
            throw new Error("Kaizen Loop payload blockedReason must be a non-empty string when status is blocked.");
        }
    }
    else if (blockedReason) {
        throw new Error("Kaizen Loop payload blockedReason is only valid when status is blocked.");
    }
    const humanRequest = normalizeHumanRequest(payload.humanRequest);
    if (humanRequest && payload.status !== "blocked") {
        throw new Error("Kaizen Loop payload humanRequest is only valid when status is blocked.");
    }
    return {
        status: payload.status,
        summary,
        notes: payload.notes,
        discoveredIssues: normalizeDiscoveredIssues(payload.discoveredIssues),
        ...(blockedReason ? { blockedReason } : {}),
        ...(humanRequest ? { humanRequest } : {})
    };
}
function hasStructuredPartialNotes(notes) {
    return hasStructuredNotes(notes, PARTIAL_NOTE_LABELS);
}
function hasStructuredNotes(notes, labels) {
    const sectionPattern = partialNoteSectionPattern(`(?:${labels.join("|")})`);
    const contentPattern = `(?=(?:(?!${PARTIAL_NOTE_PREFIX_PATTERN}${sectionPattern})[\\s\\S])*?[^\\s.;,:—–\\-_*+|#>])`;
    if (!labels.every((label) => (notes.match(new RegExp(`${PARTIAL_NOTE_PREFIX_PATTERN}${partialNoteSectionPattern(label)}`, "g"))?.length === 1 &&
        new RegExp(`${PARTIAL_NOTE_PREFIX_PATTERN}${partialNoteSectionPattern(label)}${contentPattern}`).test(notes)))) {
        return false;
    }
    const verification = new RegExp(`${PARTIAL_NOTE_PREFIX_PATTERN}${partialNoteSectionPattern("Verification")}\\s*([\\s\\S]*?)(?=${PARTIAL_NOTE_PREFIX_PATTERN}${sectionPattern}|$)`).exec(notes)?.[1].trim();
    if (!verification || !SKIPPED_VERIFICATION.test(verification)) {
        return true;
    }
    const reason = SKIPPED_VERIFICATION_WITH_REASON.exec(verification)?.[1];
    return Boolean(reason && MEANINGFUL_NOTE_CONTENT.test(reason));
}
function normalizeHumanRequest(value) {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Kaizen Loop payload humanRequest must be an object.");
    }
    assertAllowedKeys(value, new Set(["reasonCode", "requestKey", "question"]), "Kaizen Loop payload humanRequest");
    const request = value;
    if (typeof request.reasonCode !== "string" || !HUMAN_REQUEST_REASON_CODES.has(request.reasonCode)) {
        throw new Error(`Invalid Kaizen Loop payload humanRequest reasonCode: ${String(request.reasonCode)}`);
    }
    if (typeof request.question !== "string" || request.question.trim().length === 0) {
        throw new Error("Kaizen Loop payload humanRequest question must be a non-empty string.");
    }
    if (typeof request.requestKey !== "string" || !/^[a-z0-9][a-z0-9._:-]*$/.test(request.requestKey)) {
        throw new Error("Kaizen Loop payload humanRequest requestKey must be a stable lowercase semantic key.");
    }
    return {
        reasonCode: request.reasonCode,
        requestKey: request.requestKey,
        question: request.question.trim()
    };
}
export function normalizeDiscoveredIssues(value) {
    return normalizeSharedDiscoveredIssues(value, { label: "Kaizen Loop payload discoveredIssues" });
}
export function extractValidDiscoveredIssues(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return [];
    }
    const discoveredIssues = input.discoveredIssues;
    if (!Array.isArray(discoveredIssues))
        return [];
    return discoveredIssues.flatMap((issue) => {
        try {
            return normalizeDiscoveredIssues([issue]);
        }
        catch {
            return [];
        }
    });
}
function isKaizenLoopStatus(value) {
    return typeof value === "string" && STATUS_VALUES.has(value);
}
function assertAllowedKeys(input, allowedKeys, label) {
    const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
    }
}
