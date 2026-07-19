import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeSelfReview } from "../review/SelfReview.js";
import { normalizeBuildRequest } from "../types/BuildRequest.js";
import { createBuildResult, createFailedBuildResult, normalizeDiscoveredIssues, uniqueStrings } from "../types/BuildResult.js";
import { normalizeVerificationEvidence } from "../types/VerificationEvidence.js";
import type { BuildRequest, BuildRequestInput, BuildResult, BuilderAdapter, DiscoveredIssue, ImplementationOutput, IterationArtifact, PlanOutput, SelfReviewResult, TaskUnderstanding, VerificationEvidence } from "../types/contracts.js";

const REQUIRED_ADAPTER_METHODS = ["analyzeTask", "createPlan", "implement", "selfReview", "improve"];
const ITERATION_ARTIFACTS_PROPERTY = "iterationArtifacts";
const WORKSPACE_RECONCILIATION_NOTE = "Workspace changed-files reconciliation could not run because git metadata was unavailable or unreadable.";
const execFileAsync = promisify(execFile);

export interface BuilderAgentOptions {
  workspaceDir?: string;
}

export class BuilderAgent {
  adapter: BuilderAdapter;
  workspaceDir: string;

  constructor(adapter: BuilderAdapter, options: BuilderAgentOptions = {}) {
    this.adapter = adapter;
    this.workspaceDir = options.workspaceDir ?? process.cwd();
  }

  async build(input: BuildRequestInput): Promise<BuildResult> {
    const iterationArtifacts: IterationArtifact[] = [];
    let request: BuildRequest | undefined;
    let taskUnderstanding: TaskUnderstanding | undefined;
    let planSummary: string | undefined;
    let changedFiles: string[] = [];
    let discoveredIssues: DiscoveredIssue[] = [];
    let verification: VerificationEvidence[] = [];
    let residualNotes: string[] = [];

    try {
      request = normalizeBuildRequest(input);
      assertAdapter(this.adapter);
      const workspaceTracker = await createWorkspaceChangeTracker(this.workspaceDir);
      residualNotes = uniqueStrings([...residualNotes, ...workspaceTracker.residualNotes], "residualNotes");

      const analysis = await this.adapter.analyzeTask({ request });
      taskUnderstanding = createTaskUnderstanding({ request, analysis });
      const plan = await this.adapter.createPlan({ request, analysis });
      planSummary = summarizePlan(plan);
      let implementation = await this.adapter.implement({
        request,
        analysis,
        plan,
        iteration: 1
      });
      changedFiles = await reconcileChangedFiles(extractChangedFiles(implementation), workspaceTracker);
      discoveredIssues = extractDiscoveredIssues(implementation);
      verification = extractVerification(implementation);
      residualNotes = uniqueStrings([...extractResidualNotes(implementation), ...workspaceTracker.residualNotes], "residualNotes");
      let latestReview;

      for (let iteration = 1; iteration <= request.maxIterations; iteration += 1) {
        latestReview = normalizeSelfReview(
          await this.adapter.selfReview({
            request,
            analysis,
            plan,
            implementation,
            iteration,
            threshold: request.threshold
          }),
          request.threshold
        );
        const improvementInstructions = improvementInstructionsFor(latestReview);
        iterationArtifacts.push(createIterationArtifact({
          iteration,
          implementation,
          changedFiles,
          verification: extractVerification(implementation),
          residualNotes: uniqueStrings([...extractResidualNotes(implementation), ...workspaceTracker.residualNotes], "residualNotes"),
          review: latestReview,
          improvementInstructions
        }));

        if (latestReview.passed) {
          return attachIterationArtifacts(createBuildResult({
            status: "ready",
            iterations: iteration,
            taskUnderstanding,
            planSummary,
            changedFiles,
            review: latestReview,
            verification,
            residualNotes,
            discoveredIssues,
            threshold: request.threshold
          }), iterationArtifacts);
        }

        if (iteration === request.maxIterations) {
          return attachIterationArtifacts(createBuildResult({
            status: "blocked",
            iterations: iteration,
            taskUnderstanding,
            planSummary,
            changedFiles,
            review: latestReview,
            verification,
            residualNotes: [
              `Self-review did not pass within ${request.maxIterations} iteration(s).`,
              ...residualNotes
            ],
            discoveredIssues,
            threshold: request.threshold
          }), iterationArtifacts);
        }

        implementation = await this.adapter.improve({
          request,
          analysis,
          plan,
          implementation,
          review: latestReview,
          instructions: improvementInstructions,
          iteration: iteration + 1
        });
        changedFiles = await reconcileChangedFiles(uniqueStrings([...changedFiles, ...extractChangedFiles(implementation)], "changedFiles"), workspaceTracker);
        discoveredIssues = dedupeDiscoveredIssues([...discoveredIssues, ...extractDiscoveredIssues(implementation)]);
        verification = normalizeVerificationEvidence([...verification, ...extractVerification(implementation)]);
        residualNotes = uniqueStrings([...residualNotes, ...extractResidualNotes(implementation), ...workspaceTracker.residualNotes], "residualNotes");
      }

      return attachIterationArtifacts(createBuildResult({
        status: "blocked",
        iterations: request.maxIterations,
        taskUnderstanding,
        planSummary,
        changedFiles,
        review: latestReview,
        verification,
        residualNotes: ["Builder loop ended without a passing self-review."],
        discoveredIssues,
        threshold: request.threshold
      }), iterationArtifacts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallback = createFailedBuildResult(message);
      return attachIterationArtifacts(createBuildResult({
        status: "failed",
        iterations: iterationArtifacts.length,
        taskUnderstanding: taskUnderstanding ?? fallback.taskUnderstanding,
        planSummary: planSummary ?? fallback.planSummary,
        changedFiles,
        review: fallback.review,
        verification,
        residualNotes: uniqueStrings([...residualNotes, message], "residualNotes"),
        discoveredIssues,
        threshold: request?.threshold
      }), iterationArtifacts);
    }
  }
}

/**
 * @param {BuildRequestInput} request
 * @param {BuilderAdapter} adapter
 * @returns {Promise<BuildResult>}
 */
export async function runBuild(request: BuildRequestInput, adapter: BuilderAdapter): Promise<BuildResult> {
  return new BuilderAgent(adapter).build(request);
}

interface WorkspaceChangeTracker {
  workspaceDir: string;
  baseline: Map<string, string>;
  disabled: boolean;
  residualNotes: string[];
}

function assertAdapter(adapter: unknown): asserts adapter is BuilderAdapter {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Builder Agent requires an adapter object.");
  }

  const candidate = adapter as Record<string, unknown>;
  const missing = REQUIRED_ADAPTER_METHODS.filter((method) => typeof candidate[method] !== "function");
  if (missing.length > 0) {
    throw new Error(`Builder Agent adapter is missing required method(s): ${missing.join(", ")}.`);
  }
}

function summarizePlan(plan: PlanOutput): string {
  if (typeof plan === "string" && plan.trim().length > 0) {
    return plan;
  }

  if (typeof plan === "object" && plan && typeof plan.summary === "string" && plan.summary.trim().length > 0) {
    return plan.summary;
  }

  return "Builder Agent executed the adapter-provided implementation plan.";
}

function createTaskUnderstanding({ request, analysis }: { request: BuildRequest, analysis: unknown }): TaskUnderstanding {
  const summary = summarizeAnalysis(analysis) ?? `Task: ${request.task}`;
  const result: TaskUnderstanding = {
    summary,
    constraints: [...request.constraints]
  };

  if (request.goal) {
    result.goal = request.goal;
  }

  return result;
}

function summarizeAnalysis(analysis: unknown): string | undefined {
  if (typeof analysis === "string" && analysis.trim().length > 0) {
    return analysis.trim();
  }

  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    return undefined;
  }

  const input = analysis as Record<string, unknown>;

  if (typeof input.taskUnderstanding === "string" && input.taskUnderstanding.trim().length > 0) {
    return input.taskUnderstanding.trim();
  }

  if (input.taskUnderstanding && typeof input.taskUnderstanding === "object" && !Array.isArray(input.taskUnderstanding)) {
    const nestedSummary = (input.taskUnderstanding as Record<string, unknown>).summary;
    if (typeof nestedSummary === "string" && nestedSummary.trim().length > 0) {
      return nestedSummary.trim();
    }
  }

  if (typeof input.summary === "string" && input.summary.trim().length > 0) {
    return input.summary.trim();
  }

  return undefined;
}

function extractChangedFiles(implementation: ImplementationOutput): string[] {
  if (!implementation || typeof implementation === "string" || implementation.changedFiles === undefined) {
    return [];
  }

  return uniqueStrings(implementation.changedFiles, "changedFiles");
}

async function createWorkspaceChangeTracker(workspaceDir: string): Promise<WorkspaceChangeTracker> {
  const snapshot = await captureWorkspaceChangedFiles(workspaceDir);
  if (!snapshot.ok) {
    return {
      workspaceDir,
      baseline: new Map(),
      disabled: true,
      residualNotes: [WORKSPACE_RECONCILIATION_NOTE]
    };
  }

  return {
    workspaceDir,
    baseline: snapshot.fingerprints,
    disabled: false,
    residualNotes: []
  };
}

async function reconcileChangedFiles(reportedChangedFiles: string[], tracker: WorkspaceChangeTracker): Promise<string[]> {
  if (tracker.disabled) {
    return reportedChangedFiles;
  }

  const snapshot = await captureWorkspaceChangedFiles(tracker.workspaceDir);
  if (!snapshot.ok) {
    tracker.disabled = true;
    tracker.residualNotes = uniqueStrings([...tracker.residualNotes, WORKSPACE_RECONCILIATION_NOTE], "residualNotes");
    return reportedChangedFiles;
  }

  const actualChangedFiles = snapshot.changedFiles.filter((file) => tracker.baseline.get(file) !== snapshot.fingerprints.get(file));
  return uniqueStrings([...reportedChangedFiles, ...actualChangedFiles], "changedFiles");
}

type WorkspaceChangedFilesSnapshot =
  | { ok: true; changedFiles: string[]; fingerprints: Map<string, string> }
  | { ok: false };

async function captureWorkspaceChangedFiles(workspaceDir: string): Promise<WorkspaceChangedFilesSnapshot> {
  try {
    const insideWorkTree = (await runGit(["rev-parse", "--is-inside-work-tree"], workspaceDir)).trim();
    if (insideWorkTree !== "true") {
      return { ok: false };
    }

    const [trackedChanges, untrackedChanges] = await Promise.all([
      runGit(["diff", "--name-only", "HEAD", "--"], workspaceDir),
      runGit(["ls-files", "--others", "--exclude-standard"], workspaceDir)
    ]);

    const changedFiles = uniqueStrings([...lines(trackedChanges), ...lines(untrackedChanges)], "changedFiles");
    return {
      ok: true,
      changedFiles,
      fingerprints: await fingerprintWorkspaceFiles(workspaceDir, changedFiles)
    };
  } catch {
    return { ok: false };
  }
}

async function fingerprintWorkspaceFiles(workspaceDir: string, files: string[]): Promise<Map<string, string>> {
  const fingerprints = new Map<string, string>();

  await Promise.all(files.map(async (file) => {
    try {
      const content = await readFile(join(workspaceDir, file));
      fingerprints.set(file, createHash("sha256").update(content).digest("hex"));
    } catch {
      fingerprints.set(file, "missing");
    }
  }));

  return fingerprints;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function extractResidualNotes(implementation: ImplementationOutput): string[] {
  if (!implementation || typeof implementation === "string" || implementation.residualNotes === undefined) {
    return [];
  }

  return uniqueStrings(implementation.residualNotes, "residualNotes");
}

function extractVerification(implementation: ImplementationOutput): VerificationEvidence[] {
  if (!implementation || typeof implementation === "string" || implementation.verification === undefined) {
    return [];
  }

  return normalizeVerificationEvidence(implementation.verification, "Implementation verification");
}

function summarizeImplementation(implementation: ImplementationOutput): string {
  if (typeof implementation === "string" && implementation.trim().length > 0) {
    return implementation.trim();
  }

  if (implementation && typeof implementation !== "string" && typeof implementation.summary === "string" && implementation.summary.trim().length > 0) {
    return implementation.summary.trim();
  }

  const changedFiles = extractChangedFiles(implementation);
  if (changedFiles.length > 0) {
    return `Changed files: ${changedFiles.join(", ")}`;
  }

  return "Adapter did not provide an implementation summary.";
}

function extractDiscoveredIssues(implementation: ImplementationOutput): DiscoveredIssue[] {
  if (!implementation || typeof implementation === "string" || implementation.discoveredIssues === undefined) {
    return [];
  }

  return normalizeDiscoveredIssues(implementation.discoveredIssues);
}

function dedupeDiscoveredIssues(issues: DiscoveredIssue[]): DiscoveredIssue[] {
  const seen = new Set();
  const result: DiscoveredIssue[] = [];

  for (const issue of issues) {
    const key = JSON.stringify([issue.repo || "", issue.title]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }

  return result;
}

function improvementInstructionsFor(review: SelfReviewResult): string[] {
  if (review.improvementInstructions.length > 0) {
    return review.improvementInstructions;
  }

  return [...review.mustFix, ...review.shouldFix];
}

function createIterationArtifact({ iteration, implementation, changedFiles, verification, residualNotes, review, improvementInstructions }: { iteration: number, implementation: ImplementationOutput, changedFiles: string[], verification: VerificationEvidence[], residualNotes: string[], review: SelfReviewResult, improvementInstructions: string[] }): IterationArtifact {
  return {
    iteration,
    implementationSummary: summarizeImplementation(implementation),
    changedFiles,
    discoveredIssues: extractDiscoveredIssues(implementation),
    review: cloneJsonValue(review),
    improvementInstructions: cloneJsonValue(improvementInstructions),
    verification: cloneJsonValue(verification),
    residualNotes
  };
}

function attachIterationArtifacts(result: BuildResult, iterationArtifacts: IterationArtifact[]): BuildResult {
  Object.defineProperty(result, ITERATION_ARTIFACTS_PROPERTY, {
    value: iterationArtifacts,
    enumerable: false
  });

  return result;
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
