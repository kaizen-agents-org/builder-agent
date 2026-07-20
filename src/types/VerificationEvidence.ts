import type { VerificationEvidence, VerificationStatus } from "./contracts.js";

const VERIFICATION_STATUSES = new Set<VerificationStatus>(["passed", "failed", "skipped"]);
const VERIFICATION_KEYS = new Set(["command", "status", "summary"]);

export function normalizeVerificationEvidence(value: unknown, label = "Build result verification"): VerificationEvidence[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  const seen = new Set<string>();
  return value.map((entry, index) => normalizeEntry(entry, `${label}[${index}]`)).filter((entry) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeEntry(value: unknown, label: string): VerificationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  const input = value as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((key) => !VERIFICATION_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
  }

  const command = normalizeString(input.command, `${label}.command`);
  if (typeof input.status !== "string" || !VERIFICATION_STATUSES.has(input.status as VerificationStatus)) {
    throw new Error(`${label}.status must be one of: ${[...VERIFICATION_STATUSES].join(", ")}.`);
  }

  return {
    command,
    status: input.status as VerificationStatus,
    summary: normalizeString(input.summary, `${label}.summary`)
  };
}

function normalizeString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
