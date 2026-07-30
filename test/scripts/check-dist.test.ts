import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);

function fixtureEnvironment(fixtureTmp: string, overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    CI: "",
    TMPDIR: fixtureTmp,
    TMP: fixtureTmp,
    TEMP: fixtureTmp,
    ...overrides
  };
}

async function writeGitStub(binDir: string, command: string) {
  const windows = process.platform === "win32";
  const path = join(binDir, windows ? "git.cmd" : "git");
  const source = windows
    ? `@echo off\r\n${command}\r\n`
    : `#!/bin/sh\n${command}\n`;
  await writeFile(path, source, { mode: 0o755 });
}

async function createFixture(buildSource: string) {
  const root = await mkdtemp(join(tmpdir(), "check-dist-fixture-"));
  const scriptsDir = join(root, "scripts");
  const fixtureTmp = join(root, "tmp");
  await Promise.all([mkdir(scriptsDir), mkdir(fixtureTmp)]);
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { build: "node build.js" } })),
    writeFile(join(root, "build.js"), buildSource),
    writeFile(join(scriptsDir, "check-dist.js"), await readFile("scripts/check-dist.js", "utf8"))
  ]);
  return { root, script: join(scriptsDir, "check-dist.js"), fixtureTmp };
}

async function assertTemporarySnapshotRemoved(fixtureTmp: string) {
  const entries = await readdir(fixtureTmp);
  assert.deepEqual(entries.filter((entry) => entry.startsWith("builder-agent-dist-")), []);
}

describe("check-dist CLI", () => {
  it("accepts generated output that already matches the working tree", async () => {
    const fixture = await createFixture(
      'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/output.js", "fresh\\n");'
    );
    await mkdir(join(fixture.root, "dist"));
    await writeFile(join(fixture.root, "dist/output.js"), "fresh\n");

    const { stdout } = await execFileAsync(process.execPath, [fixture.script], {
      cwd: fixture.root,
      env: fixtureEnvironment(fixture.fixtureTmp)
    });

    assert.match(stdout, /Generated dist files are up to date/);
    await assertTemporarySnapshotRemoved(fixture.fixtureTmp);
  });

  it("rejects stale output and leaves the rebuilt files for review", async () => {
    const fixture = await createFixture(
      'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/output.js", "fresh\\n");'
    );
    await mkdir(join(fixture.root, "dist"));
    await writeFile(join(fixture.root, "dist/output.js"), "stale\n");

    await assert.rejects(
      execFileAsync(process.execPath, [fixture.script], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture.fixtureTmp)
      }),
      (error: { code?: number; stderr?: string }) =>
        error.code === 1 && Boolean(error.stderr?.includes("Generated dist files are stale"))
    );
    assert.equal(await readFile(join(fixture.root, "dist/output.js"), "utf8"), "fresh\n");
    await assertTemporarySnapshotRemoved(fixture.fixtureTmp);
  });

  it("requires rebuilt output to match the committed tree in CI", async () => {
    const fixture = await createFixture(
      'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/output.js", "fresh\\n");'
    );
    const binDir = join(fixture.root, "bin");
    await Promise.all([mkdir(join(fixture.root, "dist")), mkdir(binDir)]);
    await writeFile(join(fixture.root, "dist/output.js"), "fresh\n");
    await writeGitStub(
      binDir,
      process.platform === "win32"
        ? "echo( M dist/output.js"
        : "printf ' M dist/output.js\\n'"
    );

    await assert.rejects(
      execFileAsync(process.execPath, [fixture.script], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture.fixtureTmp, {
          CI: "true",
          PATH: `${binDir}${delimiter}${process.env.PATH}`
        })
      }),
      (error: { code?: number; stderr?: string }) =>
        error.code === 1 && Boolean(error.stderr?.includes(" M dist/output.js"))
    );
    await assertTemporarySnapshotRemoved(fixture.fixtureTmp);
  });

  it("restores the original output when the build fails", async () => {
    const fixture = await createFixture(
      'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/output.js", "partial\\n"); process.exit(7);'
    );
    await mkdir(join(fixture.root, "dist"));
    await writeFile(join(fixture.root, "dist/output.js"), "original\n");

    await assert.rejects(
      execFileAsync(process.execPath, [fixture.script], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture.fixtureTmp)
      }),
      (error: { code?: number }) => error.code === 7
    );
    assert.equal(await readFile(join(fixture.root, "dist/output.js"), "utf8"), "original\n");
    await assertTemporarySnapshotRemoved(fixture.fixtureTmp);
  });

  it("preserves the original output when snapshot creation fails", async () => {
    const fixture = await createFixture(
      'throw new Error("build should not run");'
    );
    await mkdir(join(fixture.root, "dist"));
    const originalOutput = join(fixture.root, "dist/output.js");
    const failSnapshot = join(fixture.root, "fail-snapshot.js");
    await writeFile(originalOutput, "original\n");
    await writeFile(
      failSnapshot,
      'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; fs.cpSync = () => { throw new Error("injected snapshot failure"); }; syncBuiltinESMExports();'
    );

    await assert.rejects(
      execFileAsync(process.execPath, ["--import", failSnapshot, fixture.script], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture.fixtureTmp)
      }),
      (error: { stderr?: string }) => Boolean(error.stderr?.includes("injected snapshot failure"))
    );

    assert.equal(await readFile(originalOutput, "utf8"), "original\n");
    await assertTemporarySnapshotRemoved(fixture.fixtureTmp);
  });

  it("restores the snapshot when the initial dist removal fails after deleting output", async () => {
    const fixture = await createFixture(
      'throw new Error("build should not run");'
    );
    await mkdir(join(fixture.root, "dist"));
    const originalOutput = join(fixture.root, "dist/output.js");
    const failRemoval = join(fixture.root, "fail-removal.js");
    await writeFile(originalOutput, "original\n");
    await writeFile(
      failRemoval,
      'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const remove = fs.rmSync; let calls = 0; fs.rmSync = (...args) => { calls += 1; remove(...args); if (calls === 1) throw new Error("injected initial removal failure"); }; syncBuiltinESMExports();'
    );

    await assert.rejects(
      execFileAsync(process.execPath, ["--import", failRemoval, fixture.script], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture.fixtureTmp)
      }),
      (error: { stderr?: string }) => Boolean(error.stderr?.includes("injected initial removal failure"))
    );

    assert.equal(await readFile(originalOutput, "utf8"), "original\n");
    await assertTemporarySnapshotRemoved(fixture.fixtureTmp);
  });

  it("retains the snapshot when restoring the original output fails", async () => {
    const fixture = await createFixture(
      'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/output.js", "partial\\n"); process.exit(7);'
    );
    await mkdir(join(fixture.root, "dist"));
    const failRestore = join(fixture.root, "fail-restore.js");
    await writeFile(join(fixture.root, "dist/output.js"), "original\n");
    await writeFile(
      failRestore,
      'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const copy = fs.cpSync; let calls = 0; fs.cpSync = (...args) => { calls += 1; if (calls === 2) throw new Error("injected restore failure"); return copy(...args); }; syncBuiltinESMExports();'
    );

    await assert.rejects(
      execFileAsync(process.execPath, ["--import", failRestore, fixture.script], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture.fixtureTmp)
      }),
      (error: { stderr?: string }) => (
        Boolean(error.stderr?.includes("injected restore failure"))
        && Boolean(error.stderr?.includes("snapshot retained at"))
      )
    );

    const snapshots = (await readdir(fixture.fixtureTmp))
      .filter((entry) => entry.startsWith("builder-agent-dist-"));
    assert.equal(snapshots.length, 1);
    assert.equal(
      await readFile(join(fixture.fixtureTmp, snapshots[0], "dist/output.js"), "utf8"),
      "original\n"
    );
    await rm(join(fixture.fixtureTmp, snapshots[0]), { force: true, recursive: true });
  });

  it("restores the original output when the comparison command is unavailable", async () => {
    const fixture = await createFixture(
      'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", { recursive: true }); writeFileSync("dist/output.js", "fresh\\n");'
    );
    const binDir = join(fixture.root, "bin");
    await Promise.all([mkdir(join(fixture.root, "dist")), mkdir(binDir)]);
    await writeFile(join(fixture.root, "dist/output.js"), "original\n");
    await writeGitStub(binDir, process.platform === "win32" ? "exit /b 2" : "exit 2");

    await assert.rejects(
      execFileAsync(process.execPath, [fixture.script], {
        cwd: fixture.root,
        env: fixtureEnvironment(fixture.fixtureTmp, {
          PATH: `${binDir}${delimiter}${process.env.PATH}`
        })
      }),
      (error: { code?: number; stderr?: string }) =>
        error.code === 2
    );
    assert.equal(await readFile(join(fixture.root, "dist/output.js"), "utf8"), "original\n");
    await assertTemporarySnapshotRemoved(fixture.fixtureTmp);
  });
});
