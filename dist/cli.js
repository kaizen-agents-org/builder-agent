#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runBuild } from "./builder/BuilderAgent.js";
import { writeBuildArtifacts } from "./artifacts.js";
import { runKaizenLoopBuilder } from "./kaizen-loop.js";
import { normalizeBuildRequest } from "./types/BuildRequest.js";
const DEFAULT_OUT_DIR = ".kaizen/builder";
main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 3;
});
async function main(args) {
    const command = args[0];
    if (command === "--version" || command === "-v") {
        console.log("builder-agent 0.1.0");
        return;
    }
    if (!command && process.env.KAIZEN_BUILD_RESULT_PATH) {
        const payload = await runKaizenLoopBuilder({
            stdin: process.stdin,
            stdout: process.stdout,
            stderr: process.stderr,
            env: process.env
        });
        process.exitCode = exitCodeForKaizenLoopPayload(payload.status);
        return;
    }
    if (!command || command === "--help" || command === "-h") {
        printUsage();
        return;
    }
    if (command === "validate-request") {
        const options = parseOptions(args.slice(1));
        const requestPath = requireOption(options, "request");
        normalizeBuildRequest(await readJson(requestPath));
        console.log("Build request is valid.");
        return;
    }
    if (command !== "build") {
        throw new Error(`Unknown command: ${command}`);
    }
    const options = parseOptions(args.slice(1));
    const requestPath = requireOption(options, "request");
    const adapterPath = requireOption(options, "adapter");
    const outDir = options.out ?? DEFAULT_OUT_DIR;
    const request = await readJson(requestPath);
    const adapter = await loadAdapter(adapterPath);
    const result = await runBuild(request, adapter);
    const artifacts = await writeBuildArtifacts(outDir, result);
    console.log(JSON.stringify({ ...result, artifacts }, null, 2));
    process.exitCode = exitCodeFor(result.status);
}
function parseOptions(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg.startsWith("--")) {
            throw new Error(`Unexpected argument: ${arg}`);
        }
        const key = arg.slice(2);
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
            throw new Error(`Missing value for --${key}`);
        }
        options[key] = value;
        index += 1;
    }
    return options;
}
function requireOption(options, key) {
    if (!options[key]) {
        throw new Error(`Missing required option --${key}`);
    }
    return options[key];
}
async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}
async function loadAdapter(path) {
    const moduleUrl = pathToFileURL(resolve(path)).href;
    const module = await import(moduleUrl);
    if (typeof module.createAdapter === "function") {
        return module.createAdapter();
    }
    return module.default ?? module;
}
function exitCodeFor(status) {
    if (status === "ready") {
        return 0;
    }
    if (status === "blocked") {
        return 2;
    }
    return 3;
}
function exitCodeForKaizenLoopPayload(status) {
    if (status === "fixed" || status === "partial") {
        return 0;
    }
    return 2;
}
function printUsage() {
    console.log(`Usage:
  builder-agent validate-request --request build-request.json
  builder-agent build --request build-request.json --adapter ./adapter.js [--out .kaizen/builder]

Kaizen Loop integration:
  KAIZEN_BUILD_RESULT_PATH=.kaizen/builder/build-result.json builder-agent < prompt.txt

Adapter modules must export analyzeTask, createPlan, implement, selfReview, and improve methods,
or export createAdapter() returning an object with those methods.`);
}
