import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(repoRoot, "dist");
const snapshotRoot = mkdtempSync(join(tmpdir(), "builder-agent-dist-"));
const snapshotDist = resolve(snapshotRoot, "dist");
const hadOriginalDist = existsSync(distDir);
let snapshotCreated = false;
let originalDistRemoved = false;
let snapshotRetained = false;

function restoreOriginalDist() {
  if (!snapshotCreated || !originalDistRemoved) {
    return;
  }
  try {
    rmSync(distDir, { force: true, recursive: true });
    if (hadOriginalDist) {
      cpSync(snapshotDist, distDir, { recursive: true });
    }
    originalDistRemoved = false;
  } catch (error) {
    snapshotRetained = true;
    throw error;
  }
}

try {
  if (hadOriginalDist) {
    cpSync(distDir, snapshotDist, { recursive: true });
  } else {
    mkdirSync(snapshotDist);
  }
  snapshotCreated = true;

  originalDistRemoved = true;
  rmSync(distDir, { force: true, recursive: true });

  const build = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit"
  });

  if (build.error) {
    console.error(`Unable to rebuild generated dist files: ${build.error.message}`);
    restoreOriginalDist();
    process.exitCode = 1;
  } else if (build.status !== 0) {
    restoreOriginalDist();
    process.exitCode = build.status ?? 1;
  } else {
    const compareCommittedOutput = Boolean(process.env.CI);
    const result = spawnSync(
      "git",
      compareCommittedOutput
        ? ["status", "--short", "--untracked-files=all", "--", "dist"]
        : ["diff", "--no-index", "--quiet", "--no-renames", "--", snapshotDist, distDir],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    );

    if (result.error) {
      console.error(`Unable to compare generated dist files: ${result.error.message}`);
      restoreOriginalDist();
      process.exitCode = 1;
    } else if (result.status === 0 && (!compareCommittedOutput || !result.stdout.trim())) {
      console.log("Generated dist files are up to date.");
    } else if ((!compareCommittedOutput && result.status === 1) || (compareCommittedOutput && result.status === 0)) {
      console.error("Generated dist files are stale:");
      if (compareCommittedOutput) {
        process.stderr.write(result.stdout);
      }
      console.error("Run `npm run build` to regenerate the dist/ files.");
      restoreOriginalDist();
      process.exitCode = 1;
    } else {
      process.stderr.write(result.stderr);
      restoreOriginalDist();
      process.exitCode = result.status ?? 1;
    }
  }
} catch (error) {
  if (!snapshotRetained) {
    restoreOriginalDist();
  }
  throw error;
} finally {
  if (snapshotRetained) {
    console.error(`Unable to restore the original dist; snapshot retained at ${snapshotDist}`);
  } else {
    rmSync(snapshotRoot, { force: true, recursive: true });
  }
}
