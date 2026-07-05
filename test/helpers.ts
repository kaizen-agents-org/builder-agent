import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

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
