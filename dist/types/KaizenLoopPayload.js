const STATUS_VALUES = new Set(["fixed", "partial", "blocked"]);
const PAYLOAD_KEYS = new Set(["status", "summary", "notes", "blockedReason", "humanRequest", "discoveredIssues"]);
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
    if (payload.status === "partial" && payload.notes.trim().length === 0) {
        throw new Error("Kaizen Loop payload notes must describe completed scope, incomplete scope, verification status, and residual risk when status is partial.");
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
function isKaizenLoopStatus(value) {
    return typeof value === "string" && STATUS_VALUES.has(value);
}
function assertAllowedKeys(input, allowedKeys, label) {
    const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
    }
}
