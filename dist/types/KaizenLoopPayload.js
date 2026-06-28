const STATUS_VALUES = new Set(["fixed", "partial", "blocked"]);
const PAYLOAD_KEYS = new Set(["status", "summary", "notes", "blockedReason", "discoveredIssues"]);
import { normalizeDiscoveredIssues as normalizeSharedDiscoveredIssues } from "./DiscoveredIssue.js";
/**
 * @param {unknown} input
 * @returns {import("./contracts.js").KaizenLoopPayload}
 */
export function normalizeKaizenLoopPayload(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Kaizen Loop payload must be an object.");
    }
    assertAllowedKeys(input, PAYLOAD_KEYS, "Kaizen Loop payload");
    if (!STATUS_VALUES.has(input.status)) {
        throw new Error(`Invalid Kaizen Loop payload status: ${String(input.status)}`);
    }
    if (typeof input.summary !== "string") {
        throw new Error("Kaizen Loop payload summary must be a string.");
    }
    if (typeof input.notes !== "string") {
        throw new Error("Kaizen Loop payload notes must be a string.");
    }
    if (input.blockedReason !== undefined && typeof input.blockedReason !== "string") {
        throw new Error("Kaizen Loop payload blockedReason must be a string.");
    }
    return {
        status: input.status,
        summary: input.summary,
        notes: input.notes,
        discoveredIssues: normalizeDiscoveredIssues(input.discoveredIssues),
        ...(typeof input.blockedReason === "string" ? { blockedReason: input.blockedReason } : {})
    };
}
/**
 * @param {unknown} value
 * @returns {import("./contracts.js").DiscoveredIssue[]}
 */
export function normalizeDiscoveredIssues(value) {
    return normalizeSharedDiscoveredIssues(value, { label: "Kaizen Loop payload discoveredIssues" });
}
function assertAllowedKeys(input, allowedKeys, label) {
    const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
    }
}
