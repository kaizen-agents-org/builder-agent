import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function writeBuildArtifacts(outDir, result) {
    await mkdir(outDir, { recursive: true });
    const selfReviewPath = join(outDir, "self-review.json");
    const buildResultPath = join(outDir, "build-result.json");
    const discoveredIssuesPath = join(outDir, "discovered-issues.json");
    const iterationArtifacts = Array.isArray(result.iterationArtifacts) ? result.iterationArtifacts : [];
    const iterationArtifactPaths = [];
    const iterationsDir = join(outDir, "iterations");
    await writeJson(selfReviewPath, result.review);
    await writeJson(buildResultPath, result);
    await writeJson(discoveredIssuesPath, result.discoveredIssues);
    await rm(iterationsDir, { recursive: true, force: true });
    for (const artifact of iterationArtifacts) {
        const iterationDir = join(iterationsDir, String(artifact.iteration));
        await mkdir(iterationDir, { recursive: true });
        const paths = {
            implementationSummaryPath: join(iterationDir, "implementation-summary.json"),
            changedFilesPath: join(iterationDir, "changed-files.json"),
            discoveredIssuesPath: join(iterationDir, "discovered-issues.json"),
            selfReviewPath: join(iterationDir, "self-review.json"),
            improvementInstructionsPath: join(iterationDir, "improvement-instructions.json"),
            residualNotesPath: join(iterationDir, "residual-notes.json")
        };
        await writeJson(paths.implementationSummaryPath, { summary: artifact.implementationSummary });
        await writeJson(paths.changedFilesPath, artifact.changedFiles);
        await writeJson(paths.discoveredIssuesPath, artifact.discoveredIssues);
        await writeJson(paths.selfReviewPath, artifact.review);
        await writeJson(paths.improvementInstructionsPath, artifact.improvementInstructions);
        await writeJson(paths.residualNotesPath, artifact.residualNotes);
        iterationArtifactPaths.push({ iteration: artifact.iteration, ...paths });
    }
    return {
        selfReviewPath,
        buildResultPath,
        discoveredIssuesPath,
        iterationArtifactPaths
    };
}
async function writeJson(path, value) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
