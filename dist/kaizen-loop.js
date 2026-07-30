import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeAgents, runImplementationAgent } from "./agents/AgentRunner.js";
import { extractValidDiscoveredIssues, normalizeKaizenLoopPayload } from "./types/KaizenLoopPayload.js";
export async function runKaizenLoopBuilder({ stdin, stdout, stderr, env }) {
    const prompt = await readStream(stdin);
    const workspaceDir = resolve(env.KAIZEN_WORKSPACE_DIR || process.cwd());
    const preferredAgents = normalizeAgents(env.KAIZEN_PREFERRED_AGENT);
    const model = env.KAIZEN_AGENT_MODEL || undefined;
    const configuredResultPath = env.KAIZEN_BUILD_RESULT_PATH;
    if (!configuredResultPath) {
        throw new Error("KAIZEN_BUILD_RESULT_PATH is required for Kaizen Loop integration.");
    }
    const resultPath = resolve(workspaceDir, configuredResultPath);
    assertPathInsideWorkspace(workspaceDir, resultPath, false);
    const resultDirectory = await prepareResultDirectory(workspaceDir, resultPath);
    const resultWriter = await startResultWriter(resultDirectory, resultPath);
    try {
        const result = await runImplementationAgent({
            agent: preferredAgents,
            prompt,
            workspaceDir,
            model,
            env
        });
        const payload = safeNormalizePayload(result.payload ?? blockedPayload(result));
        await assertResultDirectoryIdentity(resultDirectory);
        await resultWriter.publish(`${JSON.stringify(payload, null, 2)}\n`);
        await assertResultDirectoryIdentity(resultDirectory);
        stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        if (!result.payload && result.raw.trim()) {
            stderr.write(tail(result.raw, 4000));
        }
        return payload;
    }
    finally {
        await resultWriter.cancel();
    }
}
async function prepareResultDirectory(workspaceDir, resultPath) {
    const resolvedWorkspaceDir = await realpath(workspaceDir);
    const resultDir = dirname(resultPath);
    const resolvedExistingAncestor = await findExistingAncestor(resultDir);
    assertPathInsideWorkspace(resolvedWorkspaceDir, resolvedExistingAncestor, true);
    await mkdir(resultDir, { recursive: true });
    const resolvedResultDir = await realpath(resultDir);
    assertPathInsideWorkspace(resolvedWorkspaceDir, resolvedResultDir, true);
    const identity = await lstat(resolvedResultDir, { bigint: true });
    return { path: resolvedResultDir, device: identity.dev, inode: identity.ino };
}
const RESULT_WRITER_SCRIPT = String.raw `
const { randomUUID } = require("node:crypto");
const { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } = require("node:fs");
const target = process.argv[1];
const directory = lstatSync(".", { bigint: true });
process.stdout.write(JSON.stringify({ device: directory.dev.toString(), inode: directory.ino.toString() }) + "\n");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const message = Buffer.concat(chunks);
  const headerEnd = message.indexOf(10);
  const header = headerEnd === -1 ? "" : message.subarray(0, headerEnd).toString("utf8");
  const match = /^KAIZEN_RESULT_V1 ([0-9]+)$/.exec(header);
  const payloadLength = match ? Number(match[1]) : -1;
  const payloadStart = headerEnd + 1;
  const payloadEnd = payloadStart + payloadLength;
  const commitMarker = Buffer.from("\nKAIZEN_RESULT_COMMIT\n");
  if (
    !match ||
    !Number.isSafeInteger(payloadLength) ||
    payloadLength < 0 ||
    payloadEnd + commitMarker.length !== message.length ||
    !message.subarray(payloadEnd).equals(commitMarker)
  ) {
    process.stderr.write("result writer received an incomplete publish message");
    process.exitCode = 1;
    return;
  }
  const payload = message.subarray(payloadStart, payloadEnd);
  const temporary = ".kaizen-result." + randomUUID() + ".tmp";
  let created = false;
  let published = false;
  try {
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o666);
    created = true;
    let identity;
    try {
      writeFileSync(descriptor, payload);
      fsyncSync(descriptor);
      identity = fstatSync(descriptor, { bigint: true });
      if (identity.nlink !== 1n) throw new Error("temporary result file gained another link");
    } finally {
      closeSync(descriptor);
    }
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error("result target is a symlink");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    renameSync(temporary, target);
    published = true;
    const result = lstatSync(target, { bigint: true });
    if (result.isSymbolicLink() || result.nlink !== 1n || result.dev !== identity.dev || result.ino !== identity.ino) {
      throw new Error("published result identity changed");
    }
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (created && !published) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
});
`;
async function startResultWriter(resultDirectory, resultPath) {
    await assertResultDirectoryIdentity(resultDirectory);
    const child = spawn(process.execPath, ["-e", RESULT_WRITER_SCRIPT, "--", basename(resultPath)], {
        cwd: resultDirectory.path,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    const ready = await new Promise((resolveReady, rejectReady) => {
        let stdout = "";
        const onData = (chunk) => {
            stdout += chunk;
            const lineEnd = stdout.indexOf("\n");
            if (lineEnd === -1)
                return;
            child.stdout.off("data", onData);
            try {
                resolveReady(JSON.parse(stdout.slice(0, lineEnd)));
            }
            catch (error) {
                rejectReady(error);
            }
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", onData);
        child.once("error", rejectReady);
        child.once("exit", (code) => {
            rejectReady(new Error(stderr || `Result writer exited before becoming ready (${code ?? 1}).`));
        });
    });
    if (BigInt(ready.device) !== resultDirectory.device || BigInt(ready.inode) !== resultDirectory.inode) {
        child.kill("SIGKILL");
        throw resultPathError();
    }
    let used = false;
    const waitForExit = () => new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code) => {
            if (code === 0)
                resolveExit();
            else
                rejectExit(new Error(stderr || `Result writer exited with code ${code ?? 1}.`));
        });
    });
    return {
        async publish(contents) {
            if (used)
                throw new Error("Result writer has already been used.");
            used = true;
            const exit = waitForExit();
            const payload = Buffer.from(contents);
            child.stdin.end(Buffer.concat([
                Buffer.from(`KAIZEN_RESULT_V1 ${payload.length}\n`),
                payload,
                Buffer.from("\nKAIZEN_RESULT_COMMIT\n")
            ]));
            try {
                await exit;
            }
            catch {
                throw resultPathError();
            }
        },
        async cancel() {
            if (child.exitCode !== null || child.signalCode !== null)
                return;
            child.kill("SIGKILL");
            await new Promise((resolveExit) => {
                child.once("exit", () => resolveExit());
            });
        }
    };
}
async function assertResultDirectoryIdentity(directory) {
    try {
        const identity = await lstat(directory.path, { bigint: true });
        if (!identity.isDirectory() ||
            identity.dev !== directory.device ||
            identity.ino !== directory.inode) {
            throw resultPathError();
        }
    }
    catch (error) {
        if (error.code === "ENOENT")
            throw resultPathError();
        throw error;
    }
}
async function findExistingAncestor(path) {
    let candidate = path;
    while (true) {
        try {
            return await realpath(candidate);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            const parent = dirname(candidate);
            if (parent === candidate)
                throw error;
            candidate = parent;
        }
    }
}
function assertPathInsideWorkspace(workspaceDir, path, allowWorkspace) {
    const workspaceRelativePath = relative(workspaceDir, path);
    if ((!allowWorkspace && !workspaceRelativePath) ||
        workspaceRelativePath === ".." ||
        workspaceRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(workspaceRelativePath)) {
        throw resultPathError();
    }
}
function resultPathError() {
    return new Error("KAIZEN_BUILD_RESULT_PATH must resolve to a file inside KAIZEN_WORKSPACE_DIR.");
}
function safeNormalizePayload(payload) {
    try {
        return normalizeKaizenLoopPayload(payload);
    }
    catch (error) {
        const reason = "Builder agent returned an invalid Kaizen Loop payload.";
        return normalizeKaizenLoopPayload({
            status: "blocked",
            summary: reason,
            notes: error instanceof Error ? error.message : String(error),
            blockedReason: reason,
            discoveredIssues: extractValidDiscoveredIssues(payload)
        });
    }
}
function blockedPayload(result) {
    const reason = result.exitCode === 0
        ? "Builder agent did not return the required Kaizen Loop JSON payload."
        : `Builder agent exited with code ${result.exitCode}.`;
    return {
        status: "blocked",
        summary: reason,
        notes: blockedNotes(result),
        blockedReason: reason,
        discoveredIssues: result.discoveredIssues ?? []
    };
}
function blockedNotes(result) {
    const rawTail = tail(result.raw, 2000);
    if (!result.providerEvidence)
        return rawTail;
    return rawTail ? `${result.providerEvidence}\n\nRaw output tail:\n${rawTail}` : result.providerEvidence;
}
async function readStream(stream) {
    let text = "";
    for await (const chunk of stream) {
        text += chunk;
    }
    return text;
}
function tail(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return text.slice(text.length - maxLength);
}
