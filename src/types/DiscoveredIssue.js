const DISCOVERED_ISSUE_KEYS = new Set(["title", "body", "expected", "evidence", "repo", "severity", "labels"]);

/**
 * @param {unknown} value
 * @param {{ label: string }} options
 * @returns {import("./contracts.js").DiscoveredIssue[]}
 */
export function normalizeDiscoveredIssues(value, { label }) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }

  return value.map((item, index) => normalizeDiscoveredIssue(item, index, label));
}

function normalizeDiscoveredIssue(item, index, label) {
  const itemLabel = `${label}[${index}]`;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`${itemLabel} must be an object.`);
  }
  assertAllowedKeys(item, DISCOVERED_ISSUE_KEYS, itemLabel);

  if (typeof item.title !== "string" || item.title.trim().length === 0) {
    throw new Error(`${itemLabel}.title must be a non-empty string.`);
  }

  return {
    title: item.title.trim(),
    ...optionalStringField(item, "body", itemLabel),
    ...optionalStringField(item, "expected", itemLabel),
    ...optionalStringField(item, "evidence", itemLabel),
    ...optionalStringField(item, "repo", itemLabel),
    ...optionalStringField(item, "severity", itemLabel),
    ...optionalLabels(item, itemLabel)
  };
}

function optionalStringField(item, key, itemLabel) {
  const value = item[key];
  if (value === undefined) return {};
  if (typeof value !== "string") {
    throw new Error(`${itemLabel}.${key} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? { [key]: trimmed } : {};
}

function optionalLabels(item, itemLabel) {
  if (item.labels === undefined) return {};
  if (!Array.isArray(item.labels)) {
    throw new Error(`${itemLabel}.labels must be an array.`);
  }
  return { labels: uniqueStrings(item.labels, `${itemLabel}.labels`) };
}

function uniqueStrings(value, label) {
  if (value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }

  return [...new Set(value.map((item) => item.trim()))];
}

function assertAllowedKeys(input, allowedKeys, label) {
  const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));

  if (unknownKeys.length > 0) {
    throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
  }
}
