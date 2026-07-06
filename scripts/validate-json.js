import { readFile } from "node:fs/promises";
import { normalizeSelfReview } from "../dist/review/SelfReview.js";
import { normalizeBuildRequest } from "../dist/types/BuildRequest.js";
import { normalizeBuildResult } from "../dist/types/BuildResult.js";
import { normalizeKaizenLoopPayload } from "../dist/types/KaizenLoopPayload.js";

const JSON_FILES = [
  "schemas/build-request.schema.json",
  "schemas/self-review.schema.json",
  "schemas/build-result.schema.json",
  "schemas/kaizen-loop-payload.schema.json",
  "examples/build-request.example.json",
  "examples/self-review.example.json",
  "examples/build-result.example.json",
  "examples/kaizen-loop-payload.example.json"
];

const parsed = new Map();

for (const file of JSON_FILES) {
  parsed.set(file, await readJson(file));
}

validateAgainstSchema("examples/build-request.example.json", "schemas/build-request.schema.json");
validateAgainstSchema("examples/self-review.example.json", "schemas/self-review.schema.json");
validateAgainstSchema("examples/build-result.example.json", "schemas/build-result.schema.json");
validateAgainstSchema("examples/kaizen-loop-payload.example.json", "schemas/kaizen-loop-payload.schema.json");

normalizeBuildRequest(parsed.get("examples/build-request.example.json"));
normalizeSelfReview(parsed.get("examples/self-review.example.json"), 85);
normalizeBuildResult(parsed.get("examples/build-result.example.json"), 85);
normalizeKaizenLoopPayload(parsed.get("examples/kaizen-loop-payload.example.json"));

console.log("JSON files and examples are valid.");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function validateAgainstSchema(exampleFile, schemaFile) {
  const errors = validateValue(parsed.get(exampleFile), parsed.get(schemaFile), exampleFile);
  if (errors.length > 0) {
    throw new Error(`${exampleFile} does not match ${schemaFile}:\n${errors.join("\n")}`);
  }
}

function validateValue(value, schema, path, rootSchema = schema) {
  const { schema: resolved, rootSchema: root } = resolveRef(schema, rootSchema);
  const errors = [];

  for (const subschema of resolved.allOf ?? []) {
    errors.push(...validateValue(value, subschema, path, root));
  }

  if (resolved.if && matchesSchema(value, resolved.if)) {
    errors.push(...validateValue(value, resolved.then ?? {}, path, root));
  }

  if (resolved.not && matchesSchema(value, resolved.not)) {
    errors.push(`${path}: matched a forbidden schema`);
  }

  if (resolved.const !== undefined && value !== resolved.const) {
    errors.push(`${path}: expected constant ${JSON.stringify(resolved.const)}`);
  }

  if (resolved.enum && !resolved.enum.includes(value)) {
    errors.push(`${path}: expected one of ${resolved.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }

  if (resolved.type && !hasJsonType(value, resolved.type)) {
    errors.push(`${path}: expected ${resolved.type}`);
    return errors;
  }

  if (typeof value === "string") {
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      errors.push(`${path}: expected string length >= ${resolved.minLength}`);
    }
    if (resolved.pattern && !(new RegExp(resolved.pattern).test(value))) {
      errors.push(`${path}: expected string to match /${resolved.pattern}/`);
    }
  }

  if (typeof value === "number") {
    if (resolved.minimum !== undefined && value < resolved.minimum) {
      errors.push(`${path}: expected number >= ${resolved.minimum}`);
    }
    if (resolved.maximum !== undefined && value > resolved.maximum) {
      errors.push(`${path}: expected number <= ${resolved.maximum}`);
    }
  }

  if (Array.isArray(value) && resolved.items) {
    value.forEach((item, index) => {
      errors.push(...validateValue(item, resolved.items, `${path}[${index}]`, root));
    });
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const required = resolved.required ?? [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    }
    const properties = resolved.properties ?? {};
    if (resolved.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key}: unknown property`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        errors.push(...validateValue(value[key], propertySchema, `${path}.${key}`, root));
      }
    }
  }

  return errors;
}

function matchesSchema(value, schema) {
  return validateValue(value, schema, "$").length === 0;
}

function resolveRef(schema, rootSchema) {
  if (!schema.$ref) return { schema, rootSchema };
  if (schema.$ref.startsWith("#/$defs/")) {
    const name = schema.$ref.slice("#/$defs/".length);
    const resolved = rootSchema.$defs?.[name];
    if (!resolved) throw new Error(`Unknown schema reference: ${schema.$ref}`);
    return { schema: resolved, rootSchema };
  }
  const refFile = schema.$ref.replace(/^\.\//, "schemas/");
  const resolved = parsed.get(refFile);
  if (!resolved) throw new Error(`Unknown schema reference: ${schema.$ref}`);
  return { schema: resolved, rootSchema: resolved };
}

function hasJsonType(value, type) {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default:
      throw new Error(`Unsupported schema type: ${type}`);
  }
}
