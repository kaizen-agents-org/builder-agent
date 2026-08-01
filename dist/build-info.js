import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceInputs = ["package.json", "tsconfig.json", "src", "scripts/generate-build-info.js"];
export async function createBuildInfo(root = packageRoot) {
    const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const sourceCommit = process.env.BUILDER_AGENT_SOURCE_COMMIT?.trim() || "unknown";
    if (sourceCommit !== "unknown" && !/^[0-9a-f]{40,64}$/i.test(sourceCommit)) {
        throw new Error("BUILDER_AGENT_SOURCE_COMMIT must be a full Git commit hash");
    }
    return {
        version: packageMetadata.version,
        sourceCommit,
        sourceHash: await calculateSourceHash(root)
    };
}
export async function readCliBuildInfo(root = packageRoot) {
    let generated;
    try {
        generated = JSON.parse(await readFile(join(root, "dist", "build-info.json"), "utf8"));
    }
    catch {
        return unknownBuildInfo(root);
    }
    if (!isGeneratedBuildInfo(generated)) {
        return unknownBuildInfo(root);
    }
    let currentSourceHash;
    try {
        currentSourceHash = await calculateSourceHash(root);
    }
    catch {
        return { name: "builder-agent", ...generated, status: "unknown" };
    }
    return {
        name: "builder-agent",
        ...generated,
        status: currentSourceHash === generated.sourceHash ? "current" : "stale"
    };
}
async function calculateSourceHash(root) {
    const files = (await Promise.all(sourceInputs.map((input) => listFiles(join(root, input))))).flat().sort();
    const hash = createHash("sha256");
    for (const file of files) {
        hash.update(relative(root, file).replaceAll(sep, "/"));
        hash.update("\0");
        hash.update(await readFile(file));
        hash.update("\0");
    }
    return `sha256:${hash.digest("hex")}`;
}
async function listFiles(path) {
    if (!(await stat(path)).isDirectory()) {
        return [path];
    }
    const entries = await readdir(path, { withFileTypes: true });
    const files = await Promise.all(entries.map((entry) => {
        const child = join(path, entry.name);
        return entry.isDirectory() ? listFiles(child) : [child];
    }));
    return files.flat();
}
function isGeneratedBuildInfo(value) {
    return typeof value?.version === "string"
        && (value?.sourceCommit === "unknown"
            || /^[0-9a-f]{40,64}$/i.test(value?.sourceCommit))
        && /^sha256:[0-9a-f]{64}$/.test(value?.sourceHash);
}
async function unknownBuildInfo(root) {
    let version = "unknown";
    try {
        const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        if (typeof packageMetadata.version === "string") {
            version = packageMetadata.version;
        }
    }
    catch {
        // The CLI can still report that its provenance is unknown without package metadata.
    }
    return {
        name: "builder-agent",
        version,
        sourceCommit: "unknown",
        sourceHash: "unknown",
        status: "unknown"
    };
}
