import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("git", ["status", "--short", "--untracked-files=all", "--", "dist"], {
  cwd: repoRoot,
  encoding: "utf8"
});

if (result.error) {
  console.error(`Unable to check generated dist files: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

if (result.stdout.trim()) {
  console.error("Generated dist files are stale:");
  process.stderr.write(result.stdout);
  console.error("Run `npm run build` and commit the regenerated dist/ files.");
  process.exit(1);
}

console.log("Generated dist files are up to date.");
