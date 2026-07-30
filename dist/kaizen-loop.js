import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
    const resultFile = await prepareResultFile(workspaceDir, resultPath);
    try {
        const result = await runImplementationAgent({
            agent: preferredAgents,
            prompt,
            workspaceDir,
            model,
            env
        });
        const payload = safeNormalizePayload(result.payload ?? blockedPayload(result));
        await writeResultFile(resultFile, resultPath, `${JSON.stringify(payload, null, 2)}\n`);
        stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        if (!result.payload && result.raw.trim()) {
            stderr.write(tail(result.raw, 4000));
        }
        return payload;
    }
    finally {
        await resultFile.file.close();
    }
}
async function prepareResultFile(workspaceDir, resultPath) {
    const resolvedWorkspaceDir = await realpath(workspaceDir);
    const resultDir = dirname(resultPath);
    const resolvedExistingAncestor = await findExistingAncestor(resultDir);
    assertPathInsideWorkspace(resolvedWorkspaceDir, resolvedExistingAncestor, true);
    await mkdir(resultDir, { recursive: true });
    const resolvedResultDir = await realpath(resultDir);
    assertPathInsideWorkspace(resolvedWorkspaceDir, resolvedResultDir, true);
    const resolvedResultPath = join(resolvedResultDir, basename(resultPath));
    await assertResultTargetIsNotSymlink(resolvedResultPath);
    const file = await open(resolvedResultPath, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o666);
    try {
        const identity = await file.stat({ bigint: true });
        if (identity.nlink !== 1n)
            throw resultPathError();
        await assertResultFileIdentity(resultPath, identity.dev, identity.ino);
        return { file, device: identity.dev, inode: identity.ino };
    }
    catch (error) {
        await file.close();
        throw error;
    }
}
async function writeResultFile(resultFile, resultPath, contents) {
    await assertResultFileIdentity(resultPath, resultFile.device, resultFile.inode);
    await resultFile.file.truncate(0);
    await resultFile.file.writeFile(contents, "utf8");
    await resultFile.file.sync();
    await assertResultFileIdentity(resultPath, resultFile.device, resultFile.inode);
}
async function assertResultFileIdentity(path, device, inode) {
    try {
        const identity = await lstat(path, { bigint: true });
        if (identity.isSymbolicLink() ||
            identity.nlink !== 1n ||
            identity.dev !== device ||
            identity.ino !== inode) {
            throw resultPathError();
        }
    }
    catch (error) {
        if (error.code === "ENOENT")
            throw resultPathError();
        throw error;
    }
}
async function assertResultTargetIsNotSymlink(path) {
    try {
        if ((await lstat(path)).isSymbolicLink())
            throw resultPathError();
    }
    catch (error) {
        if (error.code !== "ENOENT")
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
