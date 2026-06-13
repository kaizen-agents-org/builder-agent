import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeBuildArtifacts(outDir, result) {
  await mkdir(outDir, { recursive: true });

  const selfReviewPath = join(outDir, "self-review.json");
  const buildResultPath = join(outDir, "build-result.json");

  await writeJson(selfReviewPath, result.review);
  await writeJson(buildResultPath, result);

  return {
    selfReviewPath,
    buildResultPath
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
