import { readFile } from "node:fs/promises";

const FILES = [
  "schemas/build-request.schema.json",
  "schemas/self-review.schema.json",
  "schemas/build-result.schema.json",
  "examples/build-request.example.json",
  "examples/self-review.example.json",
  "examples/build-result.example.json"
];

for (const file of FILES) {
  JSON.parse(await readFile(file, "utf8"));
}

console.log("JSON files are valid.");
