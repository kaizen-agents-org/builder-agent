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

function restoreOriginalDist() {
  rmSync(distDir, { force: true, recursive: true });
  if (hadOriginalDist) {
    cpSync(snapshotDist, distDir, { recursive: true });
  }
}

try {
  if (hadOriginalDist) {
    cpSync(distDir, snapshotDist, { recursive: true });
  } else {
    mkdirSync(snapshotDist);
  }

  rmSync(distDir, { force: true, recursive: true });

  const build = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit"
  });

  if (build.error) {
    restoreOriginalDist();
    console.error(`Unable to rebuild generated dist files: ${build.error.message}`);
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
      restoreOriginalDist();
      console.error(`Unable to compare generated dist files: ${result.error.message}`);
      process.exitCode = 1;
    } else if (result.status === 0 && (!compareCommittedOutput || !result.stdout.trim())) {
      console.log("Generated dist files are up to date.");
    } else if ((!compareCommittedOutput && result.status === 1) || (compareCommittedOutput && result.status === 0)) {
      console.error("Generated dist files are stale:");
      if (compareCommittedOutput) {
        process.stderr.write(result.stdout);
      }
      console.error("Run `npm run build` and keep the regenerated dist/ files.");
      process.exitCode = 1;
    } else {
      restoreOriginalDist();
      process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 1;
    }
  }
} catch (error) {
  restoreOriginalDist();
  throw error;
} finally {
  rmSync(snapshotRoot, { force: true, recursive: true });
}
