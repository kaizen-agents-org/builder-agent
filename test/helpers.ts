import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const passingReview = {
  score: 90,
  confidence: 0.8,
  dimensions: {
    requirementFit: 90,
    architectureQuality: 90,
    implementationQuality: 90,
    testQuality: 90,
    maintainability: 90
  },
  mustFix: [],
  shouldFix: [],
  niceToHave: [],
  improvementInstructions: [],
  passed: false
};

export const failingReview = {
  score: 70,
  confidence: 0.65,
  dimensions: {
    requirementFit: 70,
    architectureQuality: 80,
    implementationQuality: 70,
    testQuality: 60,
    maintainability: 80
  },
  mustFix: ["Add tests for the requested behavior."],
  shouldFix: [],
  niceToHave: [],
  improvementInstructions: ["Add targeted tests for the requested behavior."],
  passed: false
};

export function createAdapter({ reviews }) {
  const calls = {
    improve: 0
  };

  return {
    calls,

    async analyzeTask() {
      return { summary: "analysis" };
    },

    async createPlan() {
      return { summary: "Implement the requested change and update tests." };
    },

    async implement() {
      return {
        changedFiles: ["src/feature.js"],
        residualNotes: []
      };
    },

    async selfReview() {
      return reviews.shift();
    },

    async improve({ implementation }) {
      calls.improve += 1;
      return {
        changedFiles: [...implementation.changedFiles, "test/feature.test.js"],
        residualNotes: []
      };
    }
  };
}

export function spawnWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command exited with ${code}: ${stderr}${stdout}`));
      }
    });
    child.stdin.end(input);
  });
}

export async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path));
    } else {
      files.push(path);
    }
  }

  return files;
}

export async function createGitWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "builder-agent-workspace-"));
  await execGit(["init"], dir);
  await execGit(["config", "user.email", "builder-agent-test@example.com"], dir);
  await execGit(["config", "user.name", "Builder Agent Test"], dir);
  await writeFile(join(dir, "README.md"), "initial\n", "utf8");
  await execGit(["add", "README.md"], dir);
  await execGit(["commit", "-m", "initial"], dir);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "feature.js"), "export const value = 1;\n", "utf8");
  await execGit(["add", "src/feature.js"], dir);
  await execGit(["commit", "-m", "add feature"], dir);
  return dir;
}

export async function execGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}
