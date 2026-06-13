import { readFile } from "node:fs/promises";
import { normalizeSelfReview } from "../src/review/SelfReview.js";
import { normalizeBuildRequest } from "../src/types/BuildRequest.js";
import { normalizeBuildResult } from "../src/types/BuildResult.js";

const JSON_FILES = [
  "schemas/build-request.schema.json",
  "schemas/self-review.schema.json",
  "schemas/build-result.schema.json",
  "examples/build-request.example.json",
  "examples/self-review.example.json",
  "examples/build-result.example.json"
];

const parsed = new Map();

for (const file of JSON_FILES) {
  parsed.set(file, await readJson(file));
}

normalizeBuildRequest(parsed.get("examples/build-request.example.json"));
normalizeSelfReview(parsed.get("examples/self-review.example.json"), 85);
normalizeBuildResult(parsed.get("examples/build-result.example.json"), 85);

console.log("JSON files and examples are valid.");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
