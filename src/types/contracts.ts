import type { Readable, Writable } from "node:stream";

export type BuildStatus = "ready" | "blocked" | "failed";
export type KaizenLoopStatus = "fixed" | "partial" | "blocked";
export type BuiltInAgentKind = "claude" | "codex";
export type AgentKind = BuiltInAgentKind | (string & {});

export interface BuildRequest {
  task: string;
  goal?: string;
  constraints: string[];
  threshold: number;
  maxIterations: number;
}

export interface BuildRequestInput {
  task: string;
  goal?: string;
  constraints?: string[];
  threshold?: number;
  maxIterations?: number;
}

export interface SelfReviewDimensions {
  requirementFit: number;
  architectureQuality: number;
  implementationQuality: number;
  testQuality: number;
  maintainability: number;
}

export interface SelfReviewResult {
  score: number;
  confidence: number;
  dimensions: SelfReviewDimensions;
  mustFix: string[];
  shouldFix: string[];
  niceToHave: string[];
  improvementInstructions: string[];
  passed: boolean;
}

export interface DiscoveredIssue {
  title: string;
  body?: string;
  expected?: string;
  evidence?: string;
  repo?: string;
  severity?: string;
  labels?: string[];
}

export interface BuildResult {
  status: BuildStatus;
  iterations: number;
  planSummary: string;
  changedFiles: string[];
  review: SelfReviewResult;
  residualNotes: string[];
  discoveredIssues: DiscoveredIssue[];
  iterationArtifacts?: IterationArtifact[];
}

export interface BuildResultInput {
  status: BuildStatus;
  iterations: number;
  planSummary: string;
  changedFiles: string[];
  review: SelfReviewResult;
  residualNotes: string[];
  discoveredIssues?: DiscoveredIssue[];
  threshold?: number;
}

export interface PlanResult {
  summary: string;
}

export type PlanOutput = string | PlanResult | Record<string, unknown>;

export interface ImplementationResult {
  summary?: string;
  changedFiles?: string[];
  residualNotes?: string[];
  discoveredIssues?: DiscoveredIssue[];
}

export type ImplementationOutput = string | ImplementationResult;

export interface BuilderAdapter {
  analyzeTask(input: { request: BuildRequest }): Promise<unknown>;
  createPlan(input: { request: BuildRequest; analysis: unknown }): Promise<PlanOutput>;
  implement(input: {
    request: BuildRequest;
    analysis: unknown;
    plan: PlanOutput;
    iteration: number;
  }): Promise<ImplementationOutput>;
  selfReview(input: {
    request: BuildRequest;
    analysis: unknown;
    plan: PlanOutput;
    implementation: ImplementationOutput;
    iteration: number;
    threshold: number;
  }): Promise<SelfReviewResult>;
  improve(input: {
    request: BuildRequest;
    analysis: unknown;
    plan: PlanOutput;
    implementation: ImplementationOutput;
    review: SelfReviewResult;
    instructions: string[];
    iteration: number;
  }): Promise<ImplementationOutput>;
}

export interface IterationArtifact {
  iteration: number;
  implementationSummary: string;
  review: SelfReviewResult;
  improvementInstructions: string[];
  residualNotes: string[];
}

export interface BuildArtifactPaths {
  selfReviewPath: string;
  buildResultPath: string;
  iterationArtifactPaths: Array<{
    iteration: number;
    implementationSummaryPath: string;
    selfReviewPath: string;
    improvementInstructionsPath: string;
    residualNotesPath: string;
  }>;
}

export interface KaizenLoopPayload {
  status: KaizenLoopStatus;
  summary: string;
  notes: string;
  blockedReason?: string;
  discoveredIssues: DiscoveredIssue[];
}

export interface AgentRunInput {
  agent: AgentKind | AgentKind[];
  prompt: string;
  workspaceDir: string;
  model?: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentProviderConfig {
  command: string;
  args?: string[];
  output?: "stdout" | "last-message";
}

export interface AgentRunResult {
  exitCode: number;
  raw: string;
  payload?: KaizenLoopPayload;
}

export interface KaizenLoopBuilderIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  env: NodeJS.ProcessEnv;
}
