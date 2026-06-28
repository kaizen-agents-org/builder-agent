const STATUS_VALUES = new Set(["fixed", "partial", "blocked"]);
const PAYLOAD_KEYS = new Set(["status", "summary", "notes", "blockedReason", "discoveredIssues"]);
const DISCOVERED_ISSUE_KEYS = new Set(["title", "body", "expected", "evidence", "repo", "severity", "labels"]);

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
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Kaizen Loop payload discoveredIssues must be an array.");
  }

  return value.map((item, index) => normalizeDiscoveredIssue(item, index));
}

function normalizeDiscoveredIssue(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`Kaizen Loop payload discoveredIssues[${index}] must be an object.`);
  }
  assertAllowedKeys(item, DISCOVERED_ISSUE_KEYS, `Kaizen Loop payload discoveredIssues[${index}]`);

  if (typeof item.title !== "string" || item.title.trim().length === 0) {
    throw new Error(`Kaizen Loop payload discoveredIssues[${index}].title must be a non-empty string.`);
  }

  return {
    title: item.title.trim(),
    ...optionalStringField(item, "body", index),
    ...optionalStringField(item, "expected", index),
    ...optionalStringField(item, "evidence", index),
    ...optionalStringField(item, "repo", index),
    ...optionalStringField(item, "severity", index),
    ...optionalLabels(item, index)
  };
}

function optionalStringField(item, key, index) {
  const value = item[key];
  if (value === undefined) return {};
  if (typeof value !== "string") {
    throw new Error(`Kaizen Loop payload discoveredIssues[${index}].${key} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? { [key]: trimmed } : {};
}

function optionalLabels(item, index) {
  if (item.labels === undefined) return {};
  if (!Array.isArray(item.labels)) {
    throw new Error(`Kaizen Loop payload discoveredIssues[${index}].labels must be an array.`);
  }
  return { labels: uniqueStrings(item.labels, `discoveredIssues[${index}].labels`) };
}

function uniqueStrings(value, label) {
  if (value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`Kaizen Loop payload ${label} must be an array of non-empty strings.`);
  }

  return [...new Set(value.map((item) => item.trim()))];
}

function assertAllowedKeys(input, allowedKeys, label) {
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));

  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
  }
}
