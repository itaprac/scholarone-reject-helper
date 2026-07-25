// Zapis wyników przebiegu na dysk: JSON raportu, CSV i pliki screeningu.
import fsp from "node:fs/promises";
import path from "node:path";
import { collectArtifactRows } from "./report.js";
import { rowsToCsv } from "./csv.js";
import { screeningResultToCsv } from "../screening-report.js";

export async function writeRunArtifacts(result, { config, runId, reportDir }) {
  const jsonPath = path.join(reportDir, `${runId}.json`);
  const csvPath = path.join(reportDir, `${runId}.csv`);
  const artifacts = {
    json: jsonPath,
    csv: csvPath,
  };
  const payload = {
    runId,
    createdAt: new Date().toISOString(),
    config: publicConfigSnapshot(config),
    artifacts,
    result,
  };

  await fsp.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fsp.writeFile(csvPath, rowsToCsv(collectArtifactRows(result, runId)), "utf8");

  return artifacts;
}

export async function writeMetadataArtifact(result, { config, runId }) {
  const screeningDir = path.join(config.logsDir, "screening");
  const artifactPath = path.join(screeningDir, `${runId}.json`);
  const summaryCsvPath = path.join(screeningDir, `${runId}-summary.csv`);
  await fsp.mkdir(screeningDir, { recursive: true });
  result.summaryCsv = summaryCsvPath;
  result.artifact = artifactPath;
  await fsp.writeFile(summaryCsvPath, screeningResultToCsv(result, runId), "utf8");
  await fsp.writeFile(artifactPath, `${JSON.stringify({
    runId,
    createdAt: new Date().toISOString(),
    config: {
      startUrl: config.startUrl,
      maxChecked: config.maxChecked,
      headless: config.headless,
      browserChannel: config.browserChannel || "playwright-chromium",
      cdp: config.cdp || null,
      slowMo: config.slowMo,
      assessWithLlm: config.assessWithLlm,
      scanAllMetadata: config.scanAllMetadata,
      assessmentModel: config.assessmentModel,
      assessmentReasoningEffort: config.assessmentReasoningEffort,
      assessmentTimeoutSeconds: config.assessmentTimeoutSeconds,
      assessmentPromptLength: config.assessmentPrompt.length,
      applyAssessmentDecisions: config.applyAssessmentDecisions,
      screeningEditorName: config.screeningEditorName,
      screeningRejectMessageLength: config.screeningRejectMessage.length,
    },
    result,
  }, null, 2)}\n`, "utf8");
  return artifactPath;
}

export function publicConfigSnapshot(config) {
  return {
    startUrl: config.startUrl,
    maxChecked: config.maxChecked,
    submittedOlderThanDays: config.submittedOlderThanDays,
    headless: config.headless,
    browserChannel: config.browserChannel || "playwright-chromium",
    cdp: config.cdp || null,
    slowMo: config.slowMo,
    dryRun: config.dryRun,
    reportOnly: config.reportOnly,
    clickReject: config.clickReject,
    saveAndSend: config.saveAndSend,
    maxRejected: config.maxRejected,
    queueStartPage: config.queueStartPage || null,
    rejectFromReport: config.rejectFromReport || null,
    rejectIdsCount: config.rejectIds.length,
    rejectProgressFile: config.rejectProgressFile || null,
    requireTargets: config.requireTargets,
    autoLogin: config.autoLogin,
    hasLoginCredentials: Boolean(config.loginUsername && config.loginPassword),
  };
}

export function formatSingleAssessmentUsage(usage) {
  if (!usage?.available) return "brak danych o tokenach";
  return [
    `input=${usage.inputTokens}`,
    `cache=${usage.cachedInputTokens}`,
    `output=${usage.outputTokens}`,
    `reasoning=${usage.reasoningOutputTokens}`,
    `razem=${usage.totalTokens}`,
  ].join(", ");
}
