import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBuildInfo } from "../dist/build-info.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildInfo = await createBuildInfo(repoRoot);

await writeFile(
  resolve(repoRoot, "dist", "build-info.json"),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
  "utf8"
);
