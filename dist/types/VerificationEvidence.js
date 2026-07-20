const VERIFICATION_STATUSES = new Set(["passed", "failed", "skipped"]);
const VERIFICATION_KEYS = new Set(["command", "status", "summary"]);
export function normalizeVerificationEvidence(value, label = "Build result verification") {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array.`);
    }
    const seen = new Set();
    return value.map((entry, index) => normalizeEntry(entry, `${label}[${index}]`)).filter((entry) => {
        const key = JSON.stringify(entry);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function normalizeEntry(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    const input = value;
    const unknownKeys = Object.keys(input).filter((key) => !VERIFICATION_KEYS.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
    }
    const command = normalizeString(input.command, `${label}.command`);
    if (typeof input.status !== "string" || !VERIFICATION_STATUSES.has(input.status)) {
        throw new Error(`${label}.status must be one of: ${[...VERIFICATION_STATUSES].join(", ")}.`);
    }
    return {
        command,
        status: input.status,
        summary: normalizeString(input.summary, `${label}.summary`)
    };
}
function normalizeString(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}
