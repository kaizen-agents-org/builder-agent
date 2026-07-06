const STATUS_VALUES = new Set(["fixed", "partial", "blocked"]);
const PAYLOAD_KEYS = new Set(["status", "summary", "notes", "blockedReason", "discoveredIssues"]);
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
    if (payload.blockedReason !== undefined && typeof payload.blockedReason !== "string") {
        throw new Error("Kaizen Loop payload blockedReason must be a string.");
    }
    const blockedReason = typeof payload.blockedReason === "string" ? payload.blockedReason.trim() : undefined;
    if (payload.status === "blocked") {
        if (!blockedReason) {
            throw new Error("Kaizen Loop payload blockedReason must be a non-empty string when status is blocked.");
        }
    }
    else if (blockedReason !== undefined) {
        throw new Error("Kaizen Loop payload blockedReason is only valid when status is blocked.");
    }
    return {
        status: payload.status,
        summary,
        notes: payload.notes,
        discoveredIssues: normalizeDiscoveredIssues(payload.discoveredIssues),
        ...(blockedReason ? { blockedReason } : {})
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
