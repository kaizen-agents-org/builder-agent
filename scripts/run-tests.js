import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = join(repoRoot, "test");
const buildRoot = join(repoRoot, ".test-build");

function rewriteSpecifier(specifier) {
  if (!specifier.startsWith(".")) {
    return specifier;
  }

  if (/^(\.\.\/)+dist(\/|$)/.test(specifier)) {
    return `../${specifier}`;
  }

  if (specifier.endsWith(".ts")) {
    return `${specifier.slice(0, -3)}.js`;
  }

  return specifier;
}

function rewriteImports(source) {
  return source
    .replace(/(from\s+["'])(\.[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${rewriteSpecifier(specifier)}${suffix}`;
    })
    .replace(/(import\(\s*["'])(\.[^"']+)(["']\s*\))/g, (_match, prefix, specifier, suffix) => {
      return `${prefix}${rewriteSpecifier(specifier)}${suffix}`;
    });
}

async function listTypeScriptFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(path));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

async function transpileTests() {
  await rm(buildRoot, { force: true, recursive: true });
  const files = await listTypeScriptFiles(testRoot);
  const testFiles = [];

  for (const file of files) {
    const source = rewriteImports(await readFile(file, "utf8"));
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022
      },
      fileName: file
    });
    const outFile = join(buildRoot, relative(repoRoot, file)).replace(/\.ts$/, ".js");
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, output.outputText, "utf8");
    if (outFile.endsWith(".test.js")) {
      testFiles.push(outFile);
    }
  }

  return testFiles;
}

const testFiles = await transpileTests();
if (testFiles.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  cwd: repoRoot,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
