const DEFAULT_THRESHOLD = 85;
const DEFAULT_MAX_ITERATIONS = 3;
const BUILD_REQUEST_KEYS = new Set(["task", "goal", "constraints", "threshold", "maxIterations"]);
export { DEFAULT_MAX_ITERATIONS, DEFAULT_THRESHOLD };
export function normalizeBuildRequest(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Build request must be an object.");
    }
    assertAllowedKeys(input, BUILD_REQUEST_KEYS, "Build request");
    if (typeof input.task !== "string" || input.task.trim().length === 0) {
        throw new Error("Build request requires a non-empty task.");
    }
    const threshold = input.threshold ?? DEFAULT_THRESHOLD;
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
        throw new Error("Build request threshold must be an integer from 0 to 100.");
    }
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 20) {
        throw new Error("Build request maxIterations must be an integer from 1 to 20.");
    }
    if (input.goal !== undefined && (typeof input.goal !== "string" || input.goal.trim().length === 0)) {
        throw new Error("Build request goal must be a non-empty string when provided.");
    }
    const constraints = input.constraints ?? [];
    if (!Array.isArray(constraints) || constraints.some((item) => typeof item !== "string" || item.trim().length === 0)) {
        throw new Error("Build request constraints must be an array of non-empty strings.");
    }
    return {
        task: input.task.trim(),
        ...(input.goal !== undefined ? { goal: input.goal.trim() } : {}),
        constraints: constraints.map((item) => item.trim()),
        threshold,
        maxIterations
    };
}
function assertAllowedKeys(input, allowedKeys, label) {
    const unknownKeys = Object.keys(input).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`${label} contains unknown field(s): ${unknownKeys.join(", ")}.`);
    }
}
