import fsp from "node:fs/promises";
import path from "node:path";
import { createBrowserSession } from "./core/browser.js";
import { createLogger, waitUntilInterrupted } from "./core/logger.js";
import { createRunStatus } from "./core/run-status.js";
import { ensureLoggedIn as ensureCoreLoggedIn } from "./core/login.js";
import { pruneLogs } from "./core/log-retention.js";
import { createScreenshotWriter } from "./core/screenshots.js";
import { TIMEOUTS } from "./core/timeouts.js";
import { buildRunConfig } from "./config/run-config.js";
import { buildRunSummary } from "./reporting/report.js";
import { writeMetadataArtifact, writeRunArtifacts } from "./reporting/artifacts.js";
import { formatTokenUsage } from "./screening-report.js";
import { quickSearchManuscript as quickSearchStep } from "./steps/search.js";
import {
  countViewDetailsControls,
  ensureManuscriptListReady,
  setQueueContext,
} from "./steps/queue.js";
import { setRunContext } from "./workflows/context.js";
import { runMetadataCollection } from "./workflows/screening.js";
import { runScan } from "./workflows/reject-scan.js";
import { runRejectTargetsFromSearch } from "./workflows/reject-from-report.js";
import { runScreeningFromRun } from "./workflows/screening-from-run.js";

// Uruchomienie przebiegu odrzucania albo screeningu. Cała konfiguracja i
// wszystkie zależności są tworzone tutaj i wstrzykiwane dalej — importowanie
// któregokolwiek z modułów workflow niczego nie uruchamia.
export async function runReject(rawArgs = process.argv.slice(2)) {
  const config = buildRunConfig(rawArgs);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(config.logsDir, `${runId}.jsonl`);
  const screenshotDir = path.join(config.logsDir, "screenshots", runId);
  const reportDir = path.join(config.logsDir, "reports");

  await fsp.mkdir(screenshotDir, { recursive: true });
  await fsp.mkdir(reportDir, { recursive: true });

  const writeLog = createLogger(logFile, { echo: false });
  const runStatus = createRunStatus({
    logsDir: config.logsDir,
    runId,
    pid: process.pid,
    mode: describeMode(config),
    logFile: path.relative(path.resolve(config.logsDir, ".."), logFile).split(path.sep).join("/"),
  });
  const logEvent = async (type, payload = {}) => {
    await writeLog(type, payload);
    await runStatus(type, payload);
  };
  // Puls zapisuje się od razu, zanim ruszy przeglądarka — start Playwrighta
  // potrafi trwać kilka sekund i bez tego panel widziałby "brak przebiegu".
  await runStatus("run_prepared", {});
  const screenshots = createScreenshotWriter({
    directory: screenshotDir,
    debug: config.debugScreenshots,
  });

  // Czyszczenie startowe jest best-effort: nieudane sprzątanie nie ma prawa
  // zablokować przebiegu.
  await pruneLogs({ logsDir: config.logsDir }).catch(() => undefined);

  const ensureLoggedIn = (page, { reason = "unknown" } = {}) =>
    ensureCoreLoggedIn(page, {
      reason,
      autoLogin: config.autoLogin,
      credentials: { username: config.loginUsername, password: config.loginPassword },
      log: logEvent,
      screenshots,
    });

  const quickSearchManuscript = (page, manuscriptId) =>
    quickSearchStep(page, manuscriptId, {
      log: logEvent,
      ensureLoggedIn,
      ensureManuscriptListReady,
      countViewDetailsControls,
    });

  setQueueContext({ config, log: logEvent, ensureLoggedIn, screenshots });
  setRunContext({
    config,
    runId,
    reportDir,
    screenshots,
    log: logEvent,
    ensureLoggedIn,
    quickSearchManuscript,
  });

  const browserSession = await createBrowserSession(config);
  const { page } = browserSession;
  page.setDefaultTimeout(TIMEOUTS.default);

  try {
    await logEvent("run_started", describeRun(config));

    if (config.requireTargets && !config.rejectFromReport && config.rejectIds.length === 0) {
      throw new Error("Ten tryb wymaga --reject-from-report=... albo --reject-ids=...");
    }

    if (!config.cdp || page.url() === "about:blank") {
      await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
    }
    await ensureLoggedIn(page, { reason: "startup" });

    const result = await selectWorkflow(config)(page);

    if (config.screeningFromRun) {
      console.log(`[FROM RUN] wykonane: ${result.performed || 0}/${result.checked || 0}`);
    } else if (config.collectMetadata) {
      result.artifact = await writeMetadataArtifact(result, { config, runId });
      console.log(`[TOKEN SUMMARY] ${formatTokenUsage(result.summary?.tokenUsage)}`);
      console.log(`[SCREENING CSV] ${result.summaryCsv}`);
    } else {
      result.summary = buildRunSummary(result);
      result.artifacts = await writeRunArtifacts(result, { config, runId, reportDir });
    }

    await logEvent("run_finished", result);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const screenshot = await screenshots.error(page, "error");
    await logEvent("run_failed", { message: error.message, stack: error.stack, screenshot });
    console.error(error);
    process.exitCode = 1;
    return null;
  } finally {
    console.log(`\nLog: ${logFile}`);
    console.log(`Screenshots: ${screenshotDir}`);
    console.log(`Reports: ${reportDir}`);

    if (config.keepOpen) {
      console.log("Keep-open: przeglądarka zostaje otwarta. Wciśnij Ctrl+C, gdy skończysz sprawdzać.");
      await waitUntilInterrupted();
    }

    await browserSession.close();
  }
}

function selectWorkflow(config) {
  // Wykonanie zapisanych decyzji nie zbiera metadanych i nie woła modelu.
  if (config.screeningFromRun) return runScreeningFromRun;
  if (config.collectMetadata) return runMetadataCollection;
  if (config.rejectFromReport || config.rejectIds.length) return runRejectTargetsFromSearch;
  return runScan;
}

function describeMode(config) {
  if (config.screeningFromRun) return "screening-from-run";
  if (config.collectMetadata) {
    return config.applyAssessmentDecisions ? "screening-live" : "screening-dryrun";
  }
  if (config.rejectFromReport || config.rejectIds.length) return "reject-from-report";
  if (config.reportOnly) return "reject-dryrun";
  if (config.saveAndSend) return "live-reject";
  return "scan";
}

function describeRun(config) {
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
    keepOpen: config.keepOpen,
    autoLogin: config.autoLogin,
    hasLoginCredentials: Boolean(config.loginUsername && config.loginPassword),
    queueStartPage: config.queueStartPage || null,
    rejectFromReport: config.rejectFromReport || null,
    rejectIdsCount: config.rejectIds.length,
    rejectProgressFile: config.rejectProgressFile || null,
    requireTargets: config.requireTargets,
    collectMetadata: config.collectMetadata,
    scanAllMetadata: config.scanAllMetadata,
    assessWithLlm: config.assessWithLlm,
    applyAssessmentDecisions: config.applyAssessmentDecisions,
    assessmentModel: config.assessmentModel,
    assessmentReasoningEffort: config.assessmentReasoningEffort,
    assessmentTimeoutSeconds: config.assessmentTimeoutSeconds,
  };
}
