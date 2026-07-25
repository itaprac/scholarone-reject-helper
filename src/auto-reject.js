import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REJECT_MESSAGE } from "./default-message.js";
import { DEFAULT_SCREENING_REJECT_MESSAGE } from "./default-screening-reject-message.js";
import { DEFAULT_ASSESSMENT_PROMPT } from "./default-assessment-prompt.js";
import {
  DEFAULT_ASSESSMENT_MODEL,
  DEFAULT_ASSESSMENT_REASONING_EFFORT,
} from "./assessment-config.js";
import { deriveSimulatedContinuation, runCodexAssessment } from "./llm-assessment.js";
import {
  inspectManuscriptText,
  isRevisionManuscriptId,
  normalizeManuscriptId,
} from "./manuscript-rules.js";
import { buildScreeningBatchResult } from "./screening-batch.js";
import { formatTokenUsage, screeningResultToCsv } from "./screening-report.js";
import {
  buildAutomaticRevisionAssessment,
  classifyScreeningManuscript,
} from "./screening-assessment.js";
import {
  hasUnusualActivityAlert,
  openAndReadAbstract,
  readManuscriptSummary,
  waitForManuscriptMetadataReady,
} from "./screening-metadata.js";
import {
  approveAndAssignEditors,
  DEFAULT_EDITOR_NAME,
} from "./screening-approval.js";
import { createScreenshotWriter } from "./core/screenshots.js";
import { pruneLogs } from "./core/log-retention.js";
import { DEFAULTS } from "./config/defaults.js";
import { createBrowserSession } from "./core/browser.js";
import {
  activateLinkByText,
  clickTextControl,
  findHrefByText,
  hasVisibleTextControl,
  submitScholarOneLinkByText,
  waitForNavigationOrTimeout,
} from "./core/dom.js";
import { ensureHeaderSearchReady, openManageMenu } from "./core/navigation.js";
import {
  loadEnvFile,
  loadLoginCredentials,
  loadTextOption,
  parseArgs,
  parseBool,
  toInteger,
  toOptionalPositiveInteger,
} from "./core/env.js";
import { waitUntilInterrupted } from "./core/logger.js";
import { ensureLoggedIn as ensureCoreLoggedIn, isLoginPage } from "./core/login.js";
import { TIMEOUTS } from "./core/timeouts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const env = loadEnvFile(path.join(projectRoot, ".env"));
const loginCredentials = loadLoginCredentials(args, env);

const config = {
  startUrl:
    args["start-url"] ||
    env.START_URL ||
    DEFAULTS.startUrl,
  maxChecked: toInteger(args["max-checked"] || env.MAX_CHECKED, DEFAULTS.maxChecked),
  submittedOlderThanDays: toInteger(
    args["submitted-older-than-days"] || env.SUBMITTED_OLDER_THAN_DAYS,
    DEFAULTS.submittedOlderThanDays
  ),
  headless: parseBool(args.headless ?? env.HEADLESS, DEFAULTS.headless),
  headed: args.headed === true,
  browserChannel: args["browser-channel"] || env.BROWSER_CHANNEL || "",
  cdp: args.cdp || env.CDP || "",
  slowMo: toInteger(args["slow-mo"] || env.SLOW_MO, 0),
  stopAfterQueue: args["stop-after-queue"] === true,
  dryRun: parseBool(args["dry-run"] ?? env.DRY_RUN, false),
  reportOnly: parseBool(args["report-only"] ?? env.REPORT_ONLY, false),
  clickReject: parseBool(args["click-reject"] ?? env.CLICK_REJECT, false),
  saveAndSend: parseBool(args["save-and-send"] ?? env.SAVE_AND_SEND, false),
  maxRejected: toOptionalPositiveInteger(args["max-rejected"] || env.MAX_REJECTED),
  keepOpen: parseBool(args["keep-open"] ?? env.KEEP_OPEN, false),
  debugScreenshots: parseBool(args["debug-screenshots"] ?? env.DEBUG_SCREENSHOTS, false),
  autoLogin: parseBool(args["auto-login"] ?? env.AUTO_LOGIN, Boolean(loginCredentials.username && loginCredentials.password)),
  loginUsername: loginCredentials.username,
  loginPassword: loginCredentials.password,
  queueStartPage: toInteger(args["queue-start-page"] || env.QUEUE_START_PAGE, 0),
  rejectFromReport: args["reject-from-report"] || env.REJECT_FROM_REPORT || "",
  rejectIds: parseIdList(args["reject-ids"] || env.REJECT_IDS || ""),
  rejectProgressFile: args["reject-progress-file"] || env.REJECT_PROGRESS_FILE || "",
  requireTargets: parseBool(args["require-targets"] ?? env.REQUIRE_TARGETS, false),
  collectMetadata: args["collect-metadata"] === true,
  scanAllMetadata: parseBool(
    args["scan-all-metadata"] ?? env.SCAN_ALL_METADATA,
    false
  ),
  assessWithLlm: args["assess-with-llm"] === true,
  applyAssessmentDecisions: args["apply-assessment-decisions"] === true,
  assessmentModel:
    args["assessment-model"] ||
    env.ASSESSMENT_MODEL ||
    DEFAULT_ASSESSMENT_MODEL,
  assessmentReasoningEffort:
    args["assessment-reasoning-effort"] ||
    env.ASSESSMENT_REASONING_EFFORT ||
    DEFAULT_ASSESSMENT_REASONING_EFFORT,
  assessmentTimeoutSeconds: toInteger(
    args["assessment-timeout-seconds"] || env.ASSESSMENT_TIMEOUT_SECONDS,
    120
  ),
  assessmentPrompt: loadTextOption(args, env, {
    fileArg: "assessment-prompt-file",
    fileEnv: "ASSESSMENT_PROMPT_FILE",
    inlineArg: "assessment-prompt",
    inlineEnv: "ASSESSMENT_PROMPT",
    fallback: DEFAULT_ASSESSMENT_PROMPT,
    trim: "both",
  }),
  screeningEditorName: args["screening-editor-name"] || DEFAULT_EDITOR_NAME,
  screeningRejectMessage: loadTextOption(args, env, {
    fileArg: "screening-reject-message-file",
    fileEnv: "SCREENING_REJECT_MESSAGE_FILE",
    inlineArg: "screening-reject-message",
    inlineEnv: "SCREENING_REJECT_MESSAGE",
    fallback: DEFAULT_SCREENING_REJECT_MESSAGE,
  }),
  rejectMessage: loadTextOption(args, env, {
    fileArg: "reject-message-file",
    fileEnv: "REJECT_MESSAGE_FILE",
    inlineArg: "reject-message",
    inlineEnv: "REJECT_MESSAGE",
    fallback: DEFAULT_REJECT_MESSAGE,
  }),
  profileDir: args["profile-dir"] || DEFAULTS.profileDir,
  logsDir: args["logs-dir"] || DEFAULTS.logsDir,
};

if (config.headed) {
  config.headless = false;
}

if (config.saveAndSend) {
  config.clickReject = true;
}

if (config.dryRun) {
  config.reportOnly = true;
}

if (config.reportOnly) {
  config.clickReject = false;
  config.saveAndSend = false;
}

if (config.applyAssessmentDecisions && (!config.collectMetadata || !config.assessWithLlm)) {
  throw new Error("--apply-assessment-decisions wymaga --collect-metadata i --assess-with-llm.");
}

// Rdzeniowe ensureLoggedIn dostaje zależności wprost; reszta pliku dalej woła
// je krótko, samym powodem.
function ensureLoggedIn(page, { reason = "unknown" } = {}) {
  return ensureCoreLoggedIn(page, {
    reason,
    autoLogin: config.autoLogin,
    credentials: { username: config.loginUsername, password: config.loginPassword },
    log: logEvent,
    screenshots,
  });
}

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(config.logsDir, `${runId}.jsonl`);
const screenshotDir = path.join(config.logsDir, "screenshots", runId);
const reportDir = path.join(config.logsDir, "reports");

await fsp.mkdir(screenshotDir, { recursive: true });
await fsp.mkdir(reportDir, { recursive: true });

const screenshots = createScreenshotWriter({
  directory: screenshotDir,
  debug: config.debugScreenshots,
});

// Czyszczenie startowe jest best-effort: nieudane sprzątanie nie ma prawa
// zablokować przebiegu.
await pruneLogs({ logsDir: config.logsDir }).catch(() => undefined);

const browserSession = await createBrowserSession(config);
const { page } = browserSession;
page.setDefaultTimeout(TIMEOUTS.default);

try {
  await logEvent("run_started", {
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
  });

  if (config.requireTargets && !config.rejectFromReport && config.rejectIds.length === 0) {
    throw new Error("Ten tryb wymaga --reject-from-report=... albo --reject-ids=...");
  }

  if (!config.cdp || page.url() === "about:blank") {
    await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
  }
  await ensureLoggedIn(page, { reason: "startup" });

  const result = config.collectMetadata
    ? await runMetadataCollection(page)
    : config.rejectFromReport || config.rejectIds.length
      ? await runRejectTargetsFromSearch(page)
      : await runScan(page);

  if (config.collectMetadata) {
    result.artifact = await writeMetadataArtifact(result);
    console.log(`[TOKEN SUMMARY] ${formatTokenUsage(result.summary?.tokenUsage)}`);
    console.log(`[SCREENING CSV] ${result.summaryCsv}`);
  } else {
    result.summary = buildRunSummary(result);
    result.artifacts = await writeRunArtifacts(result);
  }

  await logEvent("run_finished", result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const screenshot = await screenshots.error(page, "error");
  await logEvent("run_failed", {
    message: error.message,
    stack: error.stack,
    screenshot,
  });
  console.error(error);
  process.exitCode = 1;
} finally {
  console.log(`\nLog: ${logFile}`);
  console.log(`Screenshots: ${screenshotDir}`);
  console.log(`Reports: ${reportDir}`);

  if (config.keepOpen) {
    console.log("Keep-open mode: przegladarka zostaje otwarta. Wcisnij Ctrl+C w terminalu, gdy skonczysz sprawdzac.");
    await waitUntilInterrupted();
  }

  await browserSession.close();
}

async function runMetadataCollection(page) {
  let checked = 0;
  let hasOpenDetailsPage = false;
  let queueExhausted = false;
  const seenManuscriptIds = new Set();
  const skippedUnusualActivity = [];
  const manuscripts = [];
  let stoppedAfterActionError = false;

  while (config.scanAllMetadata || checked < config.maxChecked) {
    if (!hasOpenDetailsPage) {
      await ensureManuscriptListReady(page);
      const opened = await openNextUnseenViewDetailsAcrossQueuePages(page, seenManuscriptIds);
      if (!opened) {
        queueExhausted = true;
        break;
      }

      const detailsReady = await waitForDetailsPageOrRelogin(page, "metadata-open-details");
      if (!detailsReady) {
        continue;
      }
      hasOpenDetailsPage = true;
    }

    await waitForManuscriptMetadataReady(page);
    const bodyText = await page.locator("body").innerText();
    const inspected = await inspectCurrentManuscript(page);
    const manuscriptId = normalizeManuscriptId(inspected.manuscriptId);

    if (manuscriptId && seenManuscriptIds.has(manuscriptId)) {
      const movedNext = await goToNextDocument(page);
      if (!movedNext) {
        await returnToList(page);
        hasOpenDetailsPage = false;
      }
      continue;
    }

    checked += 1;
    if (manuscriptId) {
      seenManuscriptIds.add(manuscriptId);
    }

    const screeningRule = classifyScreeningManuscript(manuscriptId, {
      hasUnusualActivity: hasUnusualActivityAlert(bodyText),
    });
    if (screeningRule === "skip-unusual-activity") {
      const skipped = {
        manuscriptId: manuscriptId || null,
        reason: "High rate of unusual activity",
      };
      skippedUnusualActivity.push(skipped);
      await logEvent("metadata_manuscript_skipped", {
        checked,
        ...skipped,
      });
      console.log(`[${checked}] ${manuscriptId || "NO_ID"} -> pominięty: czerwony alert unusual activity`);

      if (!config.scanAllMetadata && checked >= config.maxChecked) {
        break;
      }

      const movedNext = await goToNextDocument(page);
      if (!movedNext) {
        await returnToList(page);
        hasOpenDetailsPage = false;
      }
      continue;
    }

    const summary = await readManuscriptSummary(page);
    if (!summary.manuscriptId || !summary.title) {
      throw new Error(summary.reason || "Nie udało się odczytać tytułu manuskryptu.");
    }

    console.log(`[${checked}] ${summary.manuscriptId} -> tytuł: ${summary.title}`);
    const isRevision = isRevisionManuscriptId(summary.manuscriptId);
    const abstract = isRevision ? "" : await openAndReadAbstract(page);
    const metadata = {
      manuscriptId: summary.manuscriptId,
      title: summary.title,
      abstract,
    };
    const screenshot = await screenshots.step(page, `metadata-${summary.manuscriptId}`);

    await logEvent("metadata_collected", {
      checked,
      manuscriptId: summary.manuscriptId,
      title: summary.title,
      abstractLength: abstract.length,
      screenshot,
    });

    let assessment = null;
    let continuation = null;
    let assessmentError = null;
    let decisionAction = null;
    let actionError = null;
    if (isRevision) {
      assessment = buildAutomaticRevisionAssessment(summary.manuscriptId);
      continuation = deriveSimulatedContinuation(assessment.decision);
      await logEvent("revision_automatically_approved", {
        checked,
        manuscriptId: summary.manuscriptId,
        decision: assessment.decision,
        mode: assessment.mode,
        continuationAction: continuation.action,
      });
      console.log(`[AUTO APPROVE] ${summary.manuscriptId}: rewizja .R + liczba; pomijam abstrakt i LLM.`);
      logAssessmentBranch(continuation);
    } else if (config.assessWithLlm) {
      const llmOutputPath = path.join(
        config.logsDir,
        "screening",
        `${runId}-${summary.manuscriptId}-llm.json`
      );
      console.log(
        `[LLM] Wysyłam tytuł i abstrakt do Codex CLI (${config.assessmentModel}, reasoning: ${config.assessmentReasoningEffort})...`
      );
      try {
        assessment = await runCodexAssessment(metadata, {
          instructions: config.assessmentPrompt,
          model: config.assessmentModel,
          reasoningEffort: config.assessmentReasoningEffort,
          timeoutMs: config.assessmentTimeoutSeconds * 1000,
          outputPath: llmOutputPath,
          cwd: projectRoot,
        });
        continuation = deriveSimulatedContinuation(assessment.decision);

        await logEvent("llm_assessment_completed", {
          checked,
          manuscriptId: summary.manuscriptId,
          provider: assessment.provider,
          model: assessment.model,
          reasoningEffort: assessment.reasoningEffort,
          mode: assessment.mode,
          decision: assessment.decision,
          reason: assessment.reason,
          durationMs: assessment.durationMs,
          usage: assessment.usage,
          threadId: assessment.threadId,
          eventCount: assessment.eventCount,
          continuationAction: continuation.action,
          llmOutputPath,
          llmEventsPath: assessment.eventsPath,
        });
        console.log(`[LLM RESULT] ${assessment.decision}: ${assessment.reason}`);
        console.log(`[LLM USAGE] ${formatSingleAssessmentUsage(assessment.usage)}, czas=${assessment.durationMs} ms`);
        logAssessmentBranch(continuation);
      } catch (error) {
        assessmentError = {
          message: error.message,
          outputPath: llmOutputPath,
          eventsPath: error.eventsPath || null,
        };
        await logEvent("llm_assessment_failed", {
          checked,
          manuscriptId: summary.manuscriptId,
          message: error.message,
          llmOutputPath,
          llmEventsPath: error.eventsPath || null,
        });
        console.error(`[LLM ERROR] ${summary.manuscriptId}: ${error.message}`);
      }
    }

    if (config.applyAssessmentDecisions && assessment && !assessmentError) {
      console.log(`[LIVE ACTION] ${summary.manuscriptId}: wykonuję ${assessment.decision} w ScholarOne...`);
      try {
        decisionAction = await applyLiveAssessmentDecision(page, assessment);
        decisionAction.screenshot = await screenshots.proof(
          page,
          `live-action-complete-${assessment.decision.toLowerCase()}-${summary.manuscriptId}`
        );
        await logEvent("assessment_live_action_completed", {
          checked,
          manuscriptId: summary.manuscriptId,
          decision: assessment.decision,
          decisionAction,
        });
        console.log(`[LIVE ACTION COMPLETE] ${summary.manuscriptId}: ${assessment.decision}.`);
      } catch (error) {
        const actionScreenshot = await screenshots.error(page, `live-action-error-${summary.manuscriptId}`);
        actionError = {
          decision: assessment.decision,
          message: error.message,
          pageUrl: page.url(),
          screenshot: actionScreenshot,
        };
        stoppedAfterActionError = true;
        await logEvent("assessment_live_action_failed", {
          checked,
          manuscriptId: summary.manuscriptId,
          ...actionError,
        });
        console.error(`[LIVE ACTION ERROR] ${summary.manuscriptId}: ${error.message}`);
      }
    }

    manuscripts.push({
      metadata,
      assessment,
      continuation,
      assessmentError,
      decisionAction,
      actionError,
      screenshot,
    });

    await logEvent("metadata_batch_progress", {
      checked,
      eligibleCount: manuscripts.length,
      skippedUnusualActivityCount: skippedUnusualActivity.length,
      latestManuscriptId: summary.manuscriptId,
      liveActionCompleted: Boolean(decisionAction?.completed),
      liveActionError: actionError?.message || null,
    });

    if (stoppedAfterActionError) {
      break;
    }

    if (!config.scanAllMetadata && checked >= config.maxChecked) {
      break;
    }

    if (config.applyAssessmentDecisions && decisionAction?.completed) {
      await returnToList(page);
      hasOpenDetailsPage = false;
      continue;
    }

    const movedNext = await goToNextDocument(page);
    if (!movedNext) {
      await returnToList(page);
      hasOpenDetailsPage = false;
    }
  }

  return buildScreeningBatchResult({
    checked,
    skippedUnusualActivity,
    manuscripts,
    assessWithLlm: config.assessWithLlm,
    applyAssessmentDecisions: config.applyAssessmentDecisions,
    scanAll: config.scanAllMetadata,
    maxChecked: config.maxChecked,
    queueExhausted,
  });
}

function logAssessmentBranch(continuation) {
  const suffix = config.applyAssessmentDecisions
    ? "tryb live: decyzja zostanie wykonana w ScholarOne"
    : "dry run: bez kliknięcia w ScholarOne";
  console.log(`[WORKFLOW BRANCH] ${continuation.action} (${suffix})`);
}

async function applyLiveAssessmentDecision(page, assessment) {
  const checklistResult = await clickCompleteChecklist(page);

  if (assessment.decision === "APPROVE") {
    const approvalResult = await approveAndAssignEditors(page, {
      editorName: config.screeningEditorName,
      allowExistingAssignments: assessment.mode === "automatic-revision",
    });
    return {
      completed: true,
      decision: "APPROVE",
      checklistResult,
      approvalResult,
    };
  }

  if (assessment.decision === "REJECT") {
    const rejectResultWithPage = await clickRejectAndFillEmail(page, config.screeningRejectMessage);
    const { emailPage, ...rejectResult } = rejectResultWithPage;
    if (!rejectResult.clicked || !rejectResult.emailBodyFilled || !emailPage) {
      throw new Error(rejectResult.note || "Nie udało się otworzyć i uzupełnić wiadomości Reject.");
    }

    const saveAndSendResult = await clickSaveAndSend(emailPage, page);
    if (!saveAndSendResult.sent) {
      throw new Error(saveAndSendResult.note || "Save and Send nie potwierdził wysłania decyzji Reject.");
    }

    return {
      completed: true,
      decision: "REJECT",
      checklistResult,
      rejectResult,
      saveAndSendResult,
    };
  }

  throw new Error(`Nieobsługiwana decyzja live: ${assessment.decision}`);
}

async function runScan(page) {
  let checked = 0;
  let rejected = 0;
  let hasOpenDetailsPage = false;
  const seenManuscriptIds = new Set();
  const report = createReportSummary();
  const maxAttempts = Math.max(config.maxChecked * 4, config.maxChecked + 20);
  let attempts = 0;
  let queueStartPageApplied = false;

  while (checked < config.maxChecked && attempts < maxAttempts) {
    attempts += 1;

    if (!hasOpenDetailsPage) {
      await dismissCookieBanner(page);
      await ensureManuscriptListReady(page);

      if (!queueStartPageApplied && config.queueStartPage > 0) {
        const pageChange = await goToQueueListPage(page, String(config.queueStartPage));
        await logEvent("queue_start_page_applied", {
          requestedPage: config.queueStartPage,
          ...pageChange,
        });
        if (pageChange.changed) {
          await ensureManuscriptListReady(page);
        }
        queueStartPageApplied = true;
      }

      if (config.stopAfterQueue) {
        const screenshot = await screenshots.step(page, "queue-ready");
        return {
          status: "queue_ready",
          checked,
          viewDetailsControls: await countViewDetailsControls(page),
          screenshot,
        };
      }

      const opened = await openNextUnseenViewDetailsAcrossQueuePages(page, seenManuscriptIds);
      if (!opened) {
        return {
          status: "no_more_view_details",
          checked,
          rejected,
          seenManuscriptIds: Array.from(seenManuscriptIds),
          report,
        };
      }

      const detailsReady = await waitForDetailsPageOrRelogin(page, "open-details");
      if (!detailsReady) {
        hasOpenDetailsPage = false;
        continue;
      }
      hasOpenDetailsPage = true;
    }

    if (await isLoginPage(page)) {
      await ensureLoggedIn(page, { reason: "before-inspect" });
      hasOpenDetailsPage = false;
      continue;
    }

    const details = await inspectCurrentManuscript(page);
    const manuscriptKey = details.manuscriptId ? details.manuscriptId.toUpperCase() : null;

    if (manuscriptKey && seenManuscriptIds.has(manuscriptKey)) {
      await logEvent("duplicate_manuscript_skipped", {
        attempts,
        checked,
        manuscriptId: manuscriptKey,
      });

      const movedNext = await goToNextDocument(page);
      if (!movedNext) {
        await logEvent("next_document_unavailable", {
          checked,
          manuscriptId: manuscriptKey,
          duplicate: true,
        });
        await returnToList(page);
        hasOpenDetailsPage = false;
      }
      continue;
    }

    checked += 1;
    if (manuscriptKey) {
      seenManuscriptIds.add(manuscriptKey);
    }
    recordReportDecision(report, details);

    await logEvent("manuscript_checked", {
      rowIndex: checked - 1,
      attempts,
      ...details,
    });

    console.log(
      `[${checked}] ${details.manuscriptId || "NO_ID"} -> ${details.action}: ${details.reason}`
    );

    if (details.action === "skip") {
      if (checked >= config.maxChecked) {
        break;
      }

      const movedNext = await goToNextDocument(page);
      if (!movedNext) {
        await logEvent("next_document_unavailable", {
          checked,
          manuscriptId: details.manuscriptId,
        });
        await returnToList(page);
        hasOpenDetailsPage = false;
      }
      continue;
    }

    if (details.action !== "candidate") {
      const screenshot = await screenshots.error(page, `needs-review-${checked}`);
      return {
        status: "needs_manual_review",
        checked,
        rejected,
        details,
        report,
        screenshot,
      };
    }

    if (config.reportOnly) {
      console.log(
        `[${checked}] ${details.manuscriptId || "NO_ID"} -> report-only: WOULD REJECT (${details.reason})`
      );
      await logEvent("report_only_candidate", {
        rowIndex: checked - 1,
        details,
      });

      if (checked >= config.maxChecked) {
        break;
      }

      const movedNext = await goToNextDocument(page);
      if (!movedNext) {
        await logEvent("next_document_unavailable_report_only", {
          checked,
          manuscriptId: details.manuscriptId,
        });
        await returnToList(page);
        hasOpenDetailsPage = false;
      }
      continue;
    }

    const checklistResult = await clickCompleteChecklist(page);

    if (!config.clickReject) {
      const screenshot = await screenshots.step(page, `candidate-before-reject-${checked}`);

      await logEvent("stopped_before_reject", {
        rowIndex: checked - 1,
        details,
        checklistResult,
        screenshot,
      });

      return {
        status: "stopped_before_reject",
        checked,
        rejected,
        details,
        report,
        checklistResult,
        screenshot,
        note: "Safety stop: Reject was not clicked. Add --click-reject to click Reject, confirm OK, and fill the email body.",
      };
    }

    const rejectEmailResultWithPage = await clickRejectAndFillEmail(page);
    const { emailPage, ...rejectEmailResult } = rejectEmailResultWithPage;

    if (!rejectEmailResult.clicked || !rejectEmailResult.emailBodyFilled) {
      const screenshot = await screenshots.error(emailPage || page, `candidate-reject-step-failed-${checked}`);

      await logEvent("reject_step_failed", {
        rowIndex: checked - 1,
        details,
        checklistResult,
        rejectEmailResult,
        screenshot,
      });

      return {
        status: "reject_step_failed",
        checked,
        rejected,
        details,
        report,
        checklistResult,
        rejectEmailResult,
        screenshot,
        note: "Reject/email step did not complete. Save and Send was not clicked.",
      };
    }

    if (!config.saveAndSend) {
      const screenshot = await screenshots.step(emailPage || page, `candidate-email-filled-${checked}`);

      await logEvent("stopped_before_send", {
        rowIndex: checked - 1,
        details,
        checklistResult,
        rejectEmailResult,
        screenshot,
      });

      return {
        status: "stopped_before_send",
        checked,
        rejected,
        details,
        report,
        checklistResult,
        rejectEmailResult,
        screenshot,
        note: "Safety stop: Reject was clicked and the email body was filled, but Save and Send was not clicked. Add --save-and-send to send it.",
      };
    }

    if (hasMaxRejectedLimit() && rejected >= config.maxRejected) {
      const screenshot = await screenshots.step(emailPage || page, `candidate-max-rejected-reached-${checked}`);

      return {
        status: "max_rejected_reached_before_send",
        checked,
        rejected,
        details,
        report,
        checklistResult,
        rejectEmailResult,
        screenshot,
        note: `Safety stop: maxRejected=${config.maxRejected} was reached before Save and Send.`,
      };
    }

    const sendResult = await clickSaveAndSend(emailPage, page);
    if (!sendResult.sent) {
      const screenshot = await screenshots.error(sendResult.emailPageClosed ? page : emailPage || page, `candidate-save-send-failed-${checked}`);

      await logEvent("save_send_failed", {
        rowIndex: checked - 1,
        details,
        checklistResult,
        rejectEmailResult,
        sendResult,
        screenshot,
      });

      return {
        status: "save_send_failed",
        checked,
        rejected,
        details,
        report,
        checklistResult,
        rejectEmailResult,
        sendResult,
        screenshot,
        note: "Save and Send did not complete confidently. Skrypt zatrzymany.",
      };
    }

    rejected += 1;
    const screenshot = await screenshots.proof(page, `candidate-sent-${checked}`);

    await logEvent("candidate_rejected_and_sent", {
      rowIndex: checked - 1,
      details,
      checklistResult,
      rejectEmailResult,
      sendResult,
      screenshot,
      rejected,
    });

    console.log(`[${checked}] ${details.manuscriptId || "NO_ID"} -> sent: Reject email sent (${formatRejectedProgress(rejected)}).`);

    if (hasMaxRejectedLimit() && rejected >= config.maxRejected) {
      return {
        status: "max_rejected_reached",
        checked,
        rejected,
        details,
        report,
        checklistResult,
        rejectEmailResult,
        sendResult,
        screenshot,
        note: `Safety stop: reached maxRejected=${config.maxRejected}.`,
      };
    }

    if (checked >= config.maxChecked) {
      break;
    }

    const movedNext = await goToNextDocument(page);
    if (!movedNext) {
      await logEvent("next_document_unavailable_after_send", {
        checked,
        manuscriptId: details.manuscriptId,
      });
      await returnToList(page);
      hasOpenDetailsPage = false;
    }
  }

  if (attempts >= maxAttempts) {
    return {
      status: "attempt_limit_reached",
      checked,
      rejected,
      seenManuscriptIds: Array.from(seenManuscriptIds),
      report,
      note: "Skrypt przerwal, bo zbyt wiele razy trafil w te same dokumenty albo nie mogl przejsc dalej.",
    };
  }

  return {
    status: config.dryRun ? "dry_run_finished" : config.reportOnly ? "report_only_finished" : "max_checked_reached",
    checked,
    rejected,
    report,
  };
}

async function runRejectTargetsFromSearch(page) {
  const targets = await loadRejectTargets();
  const progressPath = getRejectProgressPath(targets);
  const progress = await loadRejectProgress(progressPath, targets);
  const report = createReportSummary();
  const results = [];
  let checked = 0;
  let rejected = 0;

  if (targets.length === 0) {
    return {
      status: "target_list_empty",
      checked,
      rejected,
      targets: 0,
      results,
      report,
      rejectProgressFile: progressPath,
      note: "No manuscript IDs found in --reject-ids or --reject-from-report.",
    };
  }

  for (const manuscriptId of targets) {
    const priorProgress = getRejectProgressEntry(progress, manuscriptId);
    if (priorProgress && isTerminalRejectProgress(priorProgress.status)) {
      results.push({
        manuscriptId,
        status: "already_processed",
        progress: priorProgress,
      });
      console.log(`[search] ${manuscriptId} -> skip: already ${priorProgress.status}`);
      continue;
    }

    if (!config.reportOnly && hasMaxRejectedLimit() && rejected >= config.maxRejected) {
      return {
        status: "max_rejected_reached",
        checked,
        rejected,
        targets: targets.length,
        results,
        report,
        rejectProgressFile: progressPath,
        note: `Safety stop: reached maxRejected=${config.maxRejected}.`,
      };
    }

    const searchResult = await quickSearchManuscript(page, manuscriptId);
    if (!searchResult.found) {
      results.push({
        manuscriptId,
        status: "not_found",
        searchResult,
      });
      await logEvent("search_target_not_found", {
        manuscriptId,
        searchResult,
      });
      continue;
    }

    const opened = await openViewDetailsByIndex(page, 0);
    if (!opened) {
      results.push({
        manuscriptId,
        status: "view_details_not_found",
        searchResult,
      });
      await logEvent("search_target_view_details_not_found", {
        manuscriptId,
        searchResult,
      });
      continue;
    }

    const detailsReady = await waitForDetailsPageOrRelogin(page, `search-open-${manuscriptId}`);
    if (!detailsReady) {
      results.push({
        manuscriptId,
        status: "login_interrupted_open_details",
        searchResult,
      });
      continue;
    }

    const details = await inspectCurrentManuscript(page);
    checked += 1;
    recordReportDecision(report, details);

    if (normalizeManuscriptId(details.manuscriptId) !== normalizeManuscriptId(manuscriptId)) {
      results.push({
        manuscriptId,
        status: "id_mismatch",
        foundManuscriptId: details.manuscriptId,
        details,
      });
      await logEvent("search_target_id_mismatch", {
        manuscriptId,
        foundManuscriptId: details.manuscriptId,
        details,
      });
      continue;
    }

    console.log(
      `[search:${checked}] ${details.manuscriptId || manuscriptId} -> ${details.action}: ${details.reason}`
    );

    if (details.action !== "candidate") {
      results.push({
        manuscriptId,
        status: "not_candidate",
        details,
      });
      continue;
    }

    if (config.reportOnly) {
      console.log(
        `[search:${checked}] ${details.manuscriptId || manuscriptId} -> dry-run: WOULD REJECT (${details.reason})`
      );
      results.push({
        manuscriptId,
        status: "would_reject",
        details,
      });
      continue;
    }

    const checklistResult = await clickCompleteChecklist(page);
    if (isNoRejectControlChecklistResult(checklistResult)) {
      const screenshot = await screenshots.step(page, `search-not-actionable-no-reject-${checked}`);
      const resultEntry = {
        manuscriptId,
        status: "not_actionable_no_reject_control",
        details,
        checklistResult,
        screenshot,
        note: "Candidate conditions still match, but this document no longer exposes Complete Checklist/Reject controls.",
      };
      results.push(resultEntry);
      await markRejectProgress(progress, progressPath, manuscriptId, {
        status: resultEntry.status,
        at: new Date().toISOString(),
        details,
        checklistResult,
        screenshot,
      });
      await logEvent("search_target_not_actionable_no_reject_control", {
        manuscriptId,
        details,
        checklistResult,
        screenshot,
      });
      console.log(`[search:${checked}] ${details.manuscriptId || manuscriptId} -> skip: no Reject control, probably already processed.`);
      continue;
    }

    if (!config.clickReject) {
      const screenshot = await screenshots.step(page, `search-candidate-before-reject-${checked}`);
      return {
        status: "stopped_before_reject",
        checked,
        rejected,
        targets: targets.length,
        results,
        report,
        rejectProgressFile: progressPath,
        details,
        checklistResult,
        screenshot,
        note: "Safety stop: Reject was not clicked. Add --click-reject or --save-and-send.",
      };
    }

    const rejectEmailResultWithPage = await clickRejectAndFillEmail(page);
    const { emailPage, ...rejectEmailResult } = rejectEmailResultWithPage;

    if (!rejectEmailResult.clicked || !rejectEmailResult.emailBodyFilled) {
      const screenshot = await screenshots.error(emailPage || page, `search-reject-step-failed-${checked}`);
      return {
        status: "reject_step_failed",
        checked,
        rejected,
        targets: targets.length,
        results,
        report,
        rejectProgressFile: progressPath,
        details,
        checklistResult,
        rejectEmailResult,
        screenshot,
        note: "Reject/email step did not complete. Save and Send was not clicked.",
      };
    }

    if (!config.saveAndSend) {
      const screenshot = await screenshots.step(emailPage || page, `search-email-filled-${checked}`);
      return {
        status: "stopped_before_send",
        checked,
        rejected,
        targets: targets.length,
        results,
        report,
        rejectProgressFile: progressPath,
        details,
        checklistResult,
        rejectEmailResult,
        screenshot,
        note: "Safety stop: Reject was clicked and email body was filled, but Save and Send was not clicked.",
      };
    }

    const sendResult = await clickSaveAndSend(emailPage, page);
    if (!sendResult.sent) {
      const screenshot = await screenshots.error(sendResult.emailPageClosed ? page : emailPage || page, `search-save-send-failed-${checked}`);
      return {
        status: "save_send_failed",
        checked,
        rejected,
        targets: targets.length,
        results,
        report,
        rejectProgressFile: progressPath,
        details,
        checklistResult,
        rejectEmailResult,
        sendResult,
        screenshot,
        note: "Save and Send did not complete confidently. Skrypt zatrzymany.",
      };
    }

    rejected += 1;
    results.push({
      manuscriptId,
      status: "sent",
      details,
      checklistResult,
      rejectEmailResult,
      sendResult,
    });
    await markRejectProgress(progress, progressPath, manuscriptId, {
      status: "sent",
      at: new Date().toISOString(),
      details,
      checklistResult,
      rejectEmailResult,
      sendResult,
    });
    console.log(`[search:${checked}] ${details.manuscriptId || manuscriptId} -> sent (${formatRejectedProgress(rejected)}).`);
  }

  return {
    status: config.dryRun ? "search_dry_run_finished" : config.reportOnly ? "search_report_finished" : "search_reject_finished",
    checked,
    rejected,
    targets: targets.length,
    results,
    report,
    rejectProgressFile: progressPath,
  };
}

async function ensureManuscriptListReady(page) {
  await page.waitForLoadState("domcontentloaded");
  await dismissCookieBanner(page);

  if ((await countViewDetailsControls(page)) > 0) {
    return;
  }

  if (await isLoginPage(page)) {
    await ensureLoggedIn(page, { reason: "queue" });
    if ((await countViewDetailsControls(page)) > 0) {
      return;
    }
  }

  const navigated = await navigateToCompleteChecklistQueue(page);
  if (navigated && (await countViewDetailsControls(page)) > 0) {
    return;
  }

  throw new Error(
    "Nie widze kontrolek 'View Details'. Skrypt probowal przejsc przez Manage -> Admin Center -> Complete Checklist. Jesli layout jest inny, uruchom codegen albo podeślij screenshot Admin Center."
  );
}

async function quickSearchManuscript(page, manuscriptId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await isLoginPage(page)) {
      await ensureLoggedIn(page, { reason: `quick-search-${manuscriptId}` });
    }

    let searchReady = await ensureHeaderSearchReady(page);
    if (!searchReady) {
      await logEvent("quick_search_header_not_ready", {
        attempt,
        manuscriptId,
        url: page.url(),
        action: "navigate_to_admin_queue",
      });
      await ensureManuscriptListReady(page);
      searchReady = await ensureHeaderSearchReady(page);
    }

    if (!searchReady) {
      await logEvent("quick_search_header_still_not_ready", {
        attempt,
        manuscriptId,
        url: page.url(),
      });
      continue;
    }

    const input = page.locator("#QUICK_SEARCH_HEADER_SEARCH_TEXT").first();
    const button = page.locator("#btn_search").first();
    await input.fill("");
    await input.fill(manuscriptId);

    await Promise.all([
      waitForNavigationOrTimeout(page, 12000),
      button.click({ timeout: 5000 }).catch(async () => {
        await input.press("Enter");
      }),
    ]);

    if (await isLoginPage(page)) {
      await ensureLoggedIn(page, { reason: `quick-search-after-submit-${manuscriptId}` });
      continue;
    }

    await waitForSearchResults(page, manuscriptId);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const viewDetailsControls = await countViewDetailsControls(page);
    const found = viewDetailsControls > 0 && bodyHasManuscriptId(bodyText, manuscriptId);

    return {
      found,
      manuscriptId,
      viewDetailsControls,
      url: page.url(),
      pageHasSearchResults: /search\s+results/i.test(bodyText),
      resultSnippet: bodyText.replace(/\s+/g, " ").slice(0, 500),
    };
  }

  return {
    found: false,
    manuscriptId,
    viewDetailsControls: 0,
    url: page.url(),
    note: "Quick search did not become ready after retry.",
  };
}

async function waitForSearchResults(page, manuscriptId) {
  await page.waitForFunction((targetId) => {
    const text = document.body?.innerText || "";
    const compactText = text.toUpperCase().replace(/\s+/g, "");
    const compactId = targetId.toUpperCase().replace(/\s+/g, "");
    return /search\s+results/i.test(text) ||
      compactText.includes(compactId) ||
      /manuscripts\s+1\s*-\s*0\s+of\s+0|no\s+manuscripts|no\s+results/i.test(text);
  }, manuscriptId, { timeout: 15000 }).catch(() => undefined);
}

function bodyHasManuscriptId(text, manuscriptId) {
  return normalizeManuscriptId(text).includes(normalizeManuscriptId(manuscriptId));
}

function createReportSummary() {
  return {
    candidates: [],
    skippedRevision: [],
    skippedOther: [],
    manualReview: [],
  };
}

function recordReportDecision(report, details) {
  const entry = {
    manuscriptId: details.manuscriptId,
    action: details.action,
    reason: details.reason,
    submittedDate: details.submittedDate || null,
    hasUnusualActivity: Boolean(details.hasUnusualActivity),
    isRevision: Boolean(details.isRevision),
    submittedMoreThanLimit: Boolean(details.submittedMoreThanLimit),
  };

  if (details.action === "candidate") {
    report.candidates.push(entry);
    return;
  }

  if (details.action === "skip" && details.isRevision) {
    report.skippedRevision.push(entry);
    return;
  }

  if (details.action === "skip") {
    report.skippedOther.push(entry);
    return;
  }

  report.manualReview.push(entry);
}

async function navigateToCompleteChecklistQueue(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await dismissCookieBanner(page);

  if ((await countViewDetailsControls(page)) > 0) {
    return true;
  }

  await logEvent("navigate_to_queue_started", {
    url: page.url(),
  });

  const adminVisible = await hasVisibleTextControl(page, /admin\s+center/i);
  await logEvent("navigate_to_queue_probe", {
    step: "initial",
    adminVisible,
    adminHref: await findHrefByText(page, /admin\s+center/i),
    checklistHref: await findHrefByText(page, /\bcomplete\s+checklist\b/i),
  });

  const adminHref = await findHrefByText(page, /admin\s+center/i);
  let adminNowVisible = await hasVisibleTextControl(page, /admin\s+center/i);
  let adminClicked = false;
  let adminSubmitAttempted = false;

  adminSubmitAttempted = await submitScholarOneLinkByText(page, /\badmin\s+center\b/i);
  if (adminSubmitAttempted) {
    adminClicked = true;
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  } else if (await activateLinkByText(page, /\badmin\s+center\b/i)) {
    adminClicked = true;
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  } else {
    if (!adminVisible) {
      const manageClicked = await openManageMenu(page);
      if (!manageClicked) {
        await logEvent("navigate_to_queue_failed", {
          step: "manage",
          url: page.url(),
        });
        return false;
      }
    }

    adminNowVisible = await hasVisibleTextControl(page, /admin\s+center/i);
  }

  if (!adminClicked && adminNowVisible) {
    adminClicked = await clickTextControl(page, /admin\s+center/i);
    if (adminClicked) {
      await waitForLikelyNavigation(page);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
  } else if (!adminClicked && adminHref) {
    adminClicked = true;
    await page.goto(adminHref, { waitUntil: "domcontentloaded" });
  }

  await logEvent("navigate_to_queue_probe", {
    step: "admin",
    adminNowVisible,
    adminClicked,
    adminSubmitAttempted,
    adminHref,
    url: page.url(),
  });

  if ((await countViewDetailsControls(page)) > 0) {
    return true;
  }

  let checklistClicked = await submitScholarOneLinkByText(page, /\bcomplete\s+checklist\b/i) ||
    await activateLinkByText(page, /\bcomplete\s+checklist\b/i) ||
    await clickTextControl(page, /^complete\s+checklist$/i) ||
    await clickTextControl(page, /\bcomplete\s+checklist\b/i);

  if (checklistClicked) {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  } else {
    const checklistHref = await findHrefByText(page, /\bcomplete\s+checklist\b/i);
    if (checklistHref) {
      checklistClicked = true;
      await page.goto(checklistHref, { waitUntil: "domcontentloaded" });
    }
  }

  const ready = (await countViewDetailsControls(page)) > 0;
  await logEvent("navigate_to_queue_finished", {
    ready,
    checklistClicked,
    checklistHref: await findHrefByText(page, /\bcomplete\s+checklist\b/i),
    url: page.url(),
  });
  return ready;
}

async function dismissCookieBanner(page) {
  const cookieButtons = [
    page.getByRole("button", { name: /accept\s+all\s+cookies/i }),
    page.getByRole("button", { name: /reject\s+all/i }),
    page.getByRole("button", { name: /^x$|close/i }),
    page.locator("button, input[type='button'], a").filter({ hasText: /accept\s+all\s+cookies/i }),
  ];

  for (const locator of cookieButtons) {
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }

    await locator.first().click({ timeout: 1500 }).catch(() => undefined);
    await page.waitForTimeout(300);
    return;
  }
}

async function countViewDetailsControls(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll("select"));
        const matchingSelects = selects.filter((select) =>
          /^SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_/i.test(select.name || "") &&
          Array.from(select.options).some((option) => /view\s+details/i.test(option.textContent || ""))
        );

        return matchingSelects.length;
      });
    } catch (error) {
      if (!/execution context|navigation|destroyed/i.test(error.message || "") || attempt === 2) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }

  return 0;
}

async function openViewDetailsByIndex(page, index) {
  const openedBySelect = await openViewDetailsSelectByIndex(page, index);
  if (openedBySelect) {
    return true;
  }

  return openViewDetailsClickableByIndex(page, index);
}

async function openNextUnseenViewDetails(page, seenManuscriptIds) {
  const target = await findNextUnseenViewDetailsSelect(page, seenManuscriptIds);
  if (!target) {
    return false;
  }

  await logEvent("open_view_details_started", {
    listIndex: target.index,
    manuscriptIdFromList: target.manuscriptId,
  });

  return openViewDetailsByIndex(page, target.index);
}

async function openNextUnseenViewDetailsAcrossQueuePages(page, seenManuscriptIds) {
  const visitedQueuePages = new Set();
  const maxQueuePageHops = config.scanAllMetadata
    ? 500
    : Math.max(3, Math.ceil(config.maxChecked / 10) + 5);

  for (let hop = 0; hop < maxQueuePageHops; hop += 1) {
    const pageInfo = await readQueuePageInfo(page);
    const queuePageKey = pageInfo?.selectedValue || pageInfo?.selectedLabel || `unknown-${hop}`;

    const opened = await openNextUnseenViewDetails(page, seenManuscriptIds);
    if (opened) {
      return true;
    }

    await logEvent("queue_page_has_no_unseen_view_details", {
      hop,
      selectedValue: pageInfo?.selectedValue || null,
      selectedLabel: pageInfo?.selectedLabel || null,
      seenCount: seenManuscriptIds.size,
    });

    if (visitedQueuePages.has(queuePageKey)) {
      await logEvent("queue_page_loop_detected", {
        hop,
        queuePageKey,
      });
      return false;
    }
    visitedQueuePages.add(queuePageKey);

    const advanced = await advanceQueueListPage(page);
    if (!advanced.advanced) {
      await logEvent("queue_page_advance_unavailable", {
        hop,
        ...advanced,
      });
      return false;
    }

    await logEvent("queue_page_advanced", {
      hop,
      ...advanced,
    });

    await ensureManuscriptListReady(page);
  }

  await logEvent("queue_page_hop_limit_reached", {
    maxQueuePageHops,
    seenCount: seenManuscriptIds.size,
  });
  return false;
}

async function findNextUnseenViewDetailsSelect(page, seenManuscriptIds) {
  return page.evaluate((seenIds) => {
    const seen = new Set(seenIds);
    const selects = Array.from(
      document.querySelectorAll("select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']")
    ).filter((select) =>
      Array.from(select.options).some((option) => /view\s+details/i.test(option.textContent || ""))
    );

    let firstWithoutId = null;

    for (let index = 0; index < selects.length; index += 1) {
      const select = selects[index];
      const row = select.closest("tr");
      const rowText = row?.innerText || "";
      const match = rowText.match(/\b([A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?)\b/i);
      const manuscriptId = match ? match[1].toUpperCase() : null;

      if (!manuscriptId) {
        firstWithoutId ??= { index, manuscriptId: null };
        continue;
      }

      if (!seen.has(manuscriptId)) {
        return { index, manuscriptId };
      }
    }

    return firstWithoutId;
  }, Array.from(seenManuscriptIds)).catch(() => null);
}

async function readQueuePageInfo(page) {
  return page.evaluate(() => {
    const select = document.querySelector("select[name='page_select']");
    if (!select) {
      return null;
    }

    const selectedOption = select.options[select.selectedIndex] || null;
    const nextOption = select.options[select.selectedIndex + 1] || null;
    return {
      selectedValue: selectedOption?.value || select.value || null,
      selectedLabel: selectedOption?.textContent?.replace(/\s+/g, " ").trim() || null,
      nextValue: nextOption?.value || null,
      nextLabel: nextOption?.textContent?.replace(/\s+/g, " ").trim() || null,
      optionCount: select.options.length,
    };
  }).catch(() => null);
}

async function advanceQueueListPage(page) {
  const before = await readQueuePageInfo(page);
  if (!before?.nextValue) {
    return {
      advanced: false,
      reason: "No next page option in page_select.",
      fromValue: before?.selectedValue || null,
      fromLabel: before?.selectedLabel || null,
    };
  }

  const pageChange = await goToQueueListPage(page, before.nextValue);
  return {
    advanced: pageChange.changed,
    reason: pageChange.reason,
    fromValue: pageChange.fromValue,
    fromLabel: pageChange.fromLabel,
    toValue: pageChange.toValue,
    toLabel: pageChange.toLabel,
  };
}

async function goToQueueListPage(page, targetPageValue, retryAfterLogin = true) {
  const before = await readQueuePageInfo(page);
  const targetValue = String(targetPageValue);
  if (!before) {
    return {
      changed: false,
      reason: "No page_select found.",
      fromValue: null,
      fromLabel: null,
      toValue: targetValue,
      toLabel: null,
    };
  }

  if (before.selectedValue === targetValue) {
    return {
      changed: false,
      reason: "Already on requested queue page.",
      fromValue: before.selectedValue,
      fromLabel: before.selectedLabel,
      toValue: targetValue,
      toLabel: before.selectedLabel,
    };
  }

  let submitted = false;
  try {
    submitted = await page.evaluate((targetValue) => {
      const form = document.forms[0];
      const select = document.querySelector("select[name='page_select']");
      if (!form || !select) {
        return false;
      }

      const targetOption = Array.from(select.options).find((option) => option.value === targetValue);
      if (!targetOption) {
        return false;
      }

      if (select.value === targetOption.value) {
        return true;
      }

      setFormValue("CURRENT_PAGE_NO", targetOption.value);
      setFormValue("JUST_PAGED", "TRUE");
      setFormValue("SEARCH_SHOW_ALL_ATTRIB_LEVELS", "N");
      setFormValue("NEXT_PAGE", "ADMIN_VIEW_MANUSCRIPTS");

      if (form.elements.PAGE_LOADED_FLAG) {
        form.elements.PAGE_LOADED_FLAG.value = "N";
      }
      if (window.getPostParams) {
        window.getPostParams();
      }

      form.target = "";
      HTMLFormElement.prototype.submit.call(form);
      return true;

      function setFormValue(name, value) {
        let field = form.elements[name];
        if (field && field.length && field.tagName === undefined) {
          field = field[0];
        }

        if (!field) {
          field = document.createElement("input");
          field.type = "hidden";
          field.name = name;
          form.appendChild(field);
        }

        field.value = value;
      }
    }, targetValue);
  } catch (error) {
    submitted = /execution context|navigation|destroyed/i.test(error.message || "");
  }

  if (!submitted) {
    return {
      changed: false,
      reason: "Could not submit target page_select page.",
      fromValue: before.selectedValue,
      fromLabel: before.selectedLabel,
      toValue: targetValue,
      toLabel: null,
    };
  }

  await waitForNavigationOrTimeout(page, 12000);

  if (await isLoginPage(page)) {
    await ensureLoggedIn(page, { reason: "queue-page-advance" });
    await ensureManuscriptListReady(page);

    const afterLogin = await readQueuePageInfo(page);
    if (retryAfterLogin && afterLogin?.selectedValue !== targetValue) {
      return goToQueueListPage(page, targetValue, false);
    }
  }

  const after = await readQueuePageInfo(page);

  return {
    changed: true,
    fromValue: before.selectedValue,
    fromLabel: before.selectedLabel,
    toValue: targetValue,
    toLabel: after?.selectedLabel || null,
  };
}

async function openViewDetailsSelectByIndex(page, index) {
  const handles = await page.locator("select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']").elementHandles();
  const matching = [];

  for (const handle of handles) {
    const hasViewDetails = await handle.evaluate((select) =>
      Array.from(select.options).some((option) => /view\s+details/i.test(option.textContent || ""))
    );
    if (hasViewDetails) {
      matching.push(handle);
    }
  }

  const handle = matching[index];
  if (!handle) {
    return false;
  }

  const optionValue = await handle.evaluate((select) => {
    const option = Array.from(select.options).find((candidate) =>
      /view\s+details/i.test(candidate.textContent || "")
    );
    return option ? option.value : null;
  });

  if (!optionValue) {
    throw new Error("View Details option not found");
  }

  const navigation = waitForNavigationOrTimeout(page, 12000);
  await handle.selectOption(optionValue).catch(async () => {
    await handle.evaluate((select, value) => {
      select.value = value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, optionValue);
  });
  await navigation;

  return true;
}

async function openViewDetailsClickableByIndex(page, index) {
  const canClick = await page.evaluate((targetIndex) => {
    const elements = Array.from(
      document.querySelectorAll("a, button, input[type='button'], input[type='submit']")
    );
    const matches = elements.filter((element) => {
      const text = [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
      ]
        .filter(Boolean)
        .join(" ");
      return /view\s+details/i.test(text);
    });
    return Boolean(matches[targetIndex]);
  }, index);

  if (!canClick) {
    return false;
  }

  await Promise.all([
    waitForLikelyNavigation(page),
    page.evaluate((targetIndex) => {
      const elements = Array.from(
        document.querySelectorAll("a, button, input[type='button'], input[type='submit']")
      );
      const matches = elements.filter((element) => {
        const text = [
          element.textContent,
          element.getAttribute("value"),
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
        ]
          .filter(Boolean)
          .join(" ");
        return /view\s+details/i.test(text);
      });
      matches[targetIndex].click();
    }, index),
  ]);

  return true;
}

async function waitForLikelyNavigation(page) {
  const beforeUrl = page.url();
  await Promise.race([
    page.waitForURL((url) => url.href !== beforeUrl, { timeout: 10000 }).catch(() => undefined),
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    page.waitForTimeout(2500),
  ]);
}

async function waitForDetailsPage(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    const hasManuscriptId = /\b[A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?\b/i.test(text);
    const hasQueueSelect = Boolean(
      document.querySelector("select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']")
    );
    const loadedFlag = document.forms[0]?.elements?.PAGE_LOADED_FLAG;
    const formIsReady = !loadedFlag || loadedFlag.value !== "N";

    return formIsReady && hasManuscriptId && !hasQueueSelect;
  }, null, {
    timeout: 15000,
  });
}

async function waitForDetailsPageOrRelogin(page, reason) {
  try {
    await waitForDetailsPage(page);
    return true;
  } catch (error) {
    if (await isLoginPage(page)) {
      await logEvent("login_detected_while_waiting_for_details", {
        reason,
        message: error.message,
        url: page.url(),
      });
      await ensureLoggedIn(page, { reason });
      return false;
    }

    throw error;
  }
}

async function inspectCurrentManuscript(page) {
  const bodyText = await page.locator("body").innerText();
  return inspectManuscriptText(bodyText, {
    submittedOlderThanDays: config.submittedOlderThanDays,
  });
}

async function clickCompleteChecklist(page) {
  const alreadyOnChecklist = await countRejectControls(page);
  if (alreadyOnChecklist > 0) {
    return {
      clicked: false,
      rejectControlsFound: alreadyOnChecklist,
      note: "Already on checklist screen; safety stop before Reject.",
    };
  }

  const clickedDetailsTab = await submitScholarOneLinkByText(
    page,
    /\bcomplete\s+checklist\b/i,
    /MANUSCRIPT_DETAILS_SHOW_TAB/i
  );

  if (clickedDetailsTab) {
    await waitForChecklistPage(page);
    return {
      clicked: true,
      rejectControlsFound: await countRejectControls(page),
      note: "Complete Checklist details tab opened; safety stop before Reject.",
    };
  }

  return {
    clicked: false,
    rejectControlsFound: await countRejectControls(page),
    note: "Candidate found, but Complete Checklist control was not found.",
  };
}

async function waitForChecklistPage(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    const elements = Array.from(
      document.querySelectorAll("a, button, input[type='button'], input[type='submit'], img")
    );
    const hasRejectControl = elements.some(isActualRejectControl);

    return hasRejectControl || /admin\s+checklist/i.test(text);

    function isActualRejectControl(element) {
      if (!isVisible(element)) {
        return false;
      }

      const ownLabel = [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const ownSrc = element.getAttribute("src") || "";
      const onclick = element.getAttribute("onclick") || "";
      const childImageLabels = Array.from(element.querySelectorAll("img"))
        .map((image) => [image.getAttribute("alt"), image.getAttribute("src")].filter(Boolean).join(" "))
        .join(" ");

      return /^reject$/i.test(ownLabel) ||
        /reject\.gif/i.test(ownSrc) ||
        /reject\.gif/i.test(childImageLabels) ||
        /immediately\s+reject/i.test(onclick);
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }, null, { timeout: 12000 }).catch(() => undefined);
}

async function countRejectControls(page) {
  return page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll("a, button, input[type='button'], input[type='submit'], img")
    );
    return elements.filter(isActualRejectControl).length;

    function isActualRejectControl(element) {
      if (!isVisible(element)) {
        return false;
      }

      const ownLabel = [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const ownSrc = element.getAttribute("src") || "";
      const onclick = element.getAttribute("onclick") || "";
      const childImageLabels = Array.from(element.querySelectorAll("img"))
        .map((image) => [image.getAttribute("alt"), image.getAttribute("src")].filter(Boolean).join(" "))
        .join(" ");

      return /^reject$/i.test(ownLabel) ||
        /reject\.gif/i.test(ownSrc) ||
        /reject\.gif/i.test(childImageLabels) ||
        /immediately\s+reject/i.test(onclick);
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }).catch(() => 0);
}

async function clickRejectAndFillEmail(page, message = config.rejectMessage) {
  const existingPages = new Set(page.context().pages());
  const newPagePromise = page.context().waitForEvent("page", { timeout: 25000 }).catch(() => null);
  const rejectSubmitResult = await submitRejectDecision(page);

  if (!rejectSubmitResult.submitted) {
    return {
      clicked: false,
      dialogMessages: rejectSubmitResult.dialogMessages || [],
      emailBodyFilled: false,
      rejectSubmitResult,
      note: rejectSubmitResult.note || "Reject control was not found.",
      emailPage: null,
    };
  }

  await Promise.race([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    page.waitForTimeout(3000),
  ]);

  let emailPage = null;
  try {
    emailPage = await waitForEmailPopupPage(page.context(), page, newPagePromise, existingPages);
  } catch (error) {
    return {
      clicked: true,
      dialogMessages: rejectSubmitResult.dialogMessages || [],
      rejectSubmitResult,
      emailBodyFilled: false,
      note: error.message,
      emailPage: null,
    };
  }

  const emailResult = await fillRejectEmailBody(emailPage, message);

  return {
    clicked: true,
    dialogMessages: rejectSubmitResult.dialogMessages || [],
    rejectSubmitResult,
    ...emailResult,
    emailPage,
  };
}

async function submitRejectDecision(page) {
  let result = null;

  try {
    result = await page.evaluate(() => {
      const form = document.forms[0];
      if (!form) {
        return {
          submitted: false,
          note: "No form found on checklist page.",
        };
      }

      const link = findRejectLink();
      if (!link) {
        return {
          submitted: false,
          note: "Reject link was not found in DOM.",
        };
      }

      const hrefScript = normalizeScript(link.getAttribute("href") || "");
      const onclickScript = normalizeScript(link.getAttribute("onclick") || "");
      const combinedScript = `${hrefScript};${onclickScript}`;
      const dialogMessages = [];
      const confirmMessage = extractConfirmMessage(onclickScript);
      if (confirmMessage) {
        dialogMessages.push(confirmMessage);
      }

      const fieldsSet = [];
      for (const match of combinedScript.matchAll(/setField\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\)/g)) {
        setFormValue(match[1], decodeHtml(match[2]));
        fieldsSet.push(match[1]);
      }

      const nextPage = hrefScript.match(/setNextPage\(['"]([^'"]+)['"]\)/)?.[1] || "MANUSCRIPT_DETAILS";
      setFormValue("NEXT_PAGE", nextPage);
      fieldsSet.push("NEXT_PAGE");

      if (window.getPostParams) {
        window.getPostParams();
      }

      form.target = "";
      if (window.showHourGlass) {
        window.showHourGlass();
      }
      HTMLFormElement.prototype.submit.call(form);

      return {
        submitted: true,
        method: "dom-form-submit",
        dialogMessages,
        fieldsSet,
        nextPage,
        linkLabel: linkLabel(link).slice(0, 240),
      };

      function findRejectLink() {
        const links = Array.from(document.querySelectorAll("a"));
        const candidates = links
          .map((candidate) => ({
            candidate,
            label: linkLabel(candidate),
            rect: candidate.getBoundingClientRect(),
          }))
          .filter(({ label, rect }) =>
            rect.width > 0 &&
            rect.height > 0 &&
            (/reject\.gif/i.test(label) || /immediately\s+reject/i.test(label) || /^reject$/i.test(label.trim()))
          );

        return candidates.find(({ label }) => /immediately\s+reject/i.test(label))?.candidate ||
          candidates.find(({ label }) => /reject\.gif/i.test(label))?.candidate ||
          candidates[0]?.candidate ||
          null;
      }

      function linkLabel(link) {
        return [
          link.textContent,
          link.getAttribute("value"),
          link.getAttribute("title"),
          link.getAttribute("aria-label"),
          link.getAttribute("alt"),
          link.getAttribute("href"),
          link.getAttribute("onclick"),
          Array.from(link.querySelectorAll("img"))
            .map((image) => [image.getAttribute("alt"), image.getAttribute("src")].filter(Boolean).join(" "))
            .join(" "),
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }

      function normalizeScript(script) {
        return script.replace(/^javascript:/i, "");
      }

      function extractConfirmMessage(script) {
        const match = script.match(/confirm\((['"])([\s\S]*?)\1\)/);
        return match ? decodeHtml(match[2]) : null;
      }

      function setFormValue(name, value) {
        let field = form.elements[name];
        if (field && field.length && field.tagName === undefined) {
          field = field[0];
        }

        if (!field) {
          field = document.createElement("input");
          field.type = "hidden";
          field.name = name;
          form.appendChild(field);
        }

        field.value = value;
      }

      function decodeHtml(value) {
        const textarea = document.createElement("textarea");
        textarea.innerHTML = value;
        return textarea.value;
      }
    });
  } catch (error) {
    if (/execution context|navigation|destroyed/i.test(error.message || "")) {
      return {
        submitted: true,
        method: "dom-form-submit",
        dialogMessages: [],
        note: "Form submission triggered navigation before diagnostics were returned.",
      };
    }

    throw error;
  }

  return result || {
    submitted: false,
    note: "Reject submission returned no result.",
  };
}

async function waitForEmailPopupPage(context, fallbackPage, newPagePromise, existingPages) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const emailPage = await findEmailPopupPage(context.pages(), fallbackPage, existingPages);
    if (emailPage) {
      return emailPage;
    }

    const newPage = await Promise.race([
      newPagePromise,
      fallbackPage.waitForTimeout(500).then(() => null),
    ]);

    if (newPage && await pageHasEmailBody(newPage)) {
      return newPage;
    }
  }

  if (await pageHasEmailBody(fallbackPage)) {
    return fallbackPage;
  }

  throw new Error("Reject clicked, but email popup with EMAIL_TEMPLATE_BODY was not found.");
}

async function findEmailPopupPage(pages, fallbackPage, existingPages) {
  for (const candidate of pages) {
    if (candidate !== fallbackPage && existingPages.has(candidate)) {
      continue;
    }

    if (await pageHasEmailBody(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function pageHasEmailBody(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => undefined);

  for (const frame of page.frames()) {
    const count = await frame.locator("textarea[name='EMAIL_TEMPLATE_BODY']").count().catch(() => 0);
    if (count > 0) {
      return true;
    }
  }

  return false;
}

async function fillRejectEmailBody(emailPage, message) {
  const frame = await waitForEmailBodyFrame(emailPage);
  const bodyLocator = frame.locator("textarea[name='EMAIL_TEMPLATE_BODY']").first();

  await bodyLocator.fill(message);
  await bodyLocator.evaluate((element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  });

  const filledValue = await bodyLocator.inputValue();

  return {
    emailBodyFilled: filledValue === message,
    emailBodyLength: filledValue.length,
    expectedEmailBodyLength: message.length,
    emailFrameName: frame.name() || null,
    emailPageUrl: emailPage.url(),
    saveAndSendControlsFound: await countSaveAndSendControls(emailPage),
    note: "Reject was clicked and email body was replaced. Save and Send is handled in the next step when enabled.",
  };
}

async function clickSaveAndSend(emailPage, openerPage) {
  if (!emailPage || emailPage.isClosed()) {
    return {
      clicked: false,
      sent: false,
      emailPageClosed: true,
      note: "Email popup is already closed before Save and Send.",
    };
  }

  const dialogMessages = [];
  const dialogHandler = async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.accept().catch(() => undefined);
  };

  emailPage.on("dialog", dialogHandler);

  try {
    const target = await findSaveAndSendControl(emailPage);
    if (!target) {
      return {
        clicked: false,
        sent: false,
        emailPageClosed: false,
        dialogMessages,
        note: "Save and Send control was not found.",
      };
    }

    const closePromise = emailPage.waitForEvent("close", { timeout: 30000 })
      .then(() => true)
      .catch(() => false);

    await target.locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.locator.click({ timeout: 10000 });

    const popupClosed = await closePromise;
    if (!popupClosed) {
      const stillHasEmailBody = await pageHasEmailBody(emailPage).catch(() => false);
      return {
        clicked: true,
        sent: false,
        emailPageClosed: false,
        stillHasEmailBody,
        dialogMessages,
        saveAndSendFrameName: target.frameName,
        note: "Save and Send was clicked, but the email popup did not close within the timeout.",
      };
    }

    await openerPage.bringToFront().catch(() => undefined);
    await Promise.race([
      openerPage.waitForLoadState("domcontentloaded").catch(() => undefined),
      openerPage.waitForTimeout(3000),
    ]);

    return {
      clicked: true,
      sent: true,
      emailPageClosed: true,
      dialogMessages,
      saveAndSendFrameName: target.frameName,
      openerUrl: openerPage.url(),
      note: "Save and Send clicked and popup closed.",
    };
  } finally {
    emailPage.off("dialog", dialogHandler);
  }
}

async function findSaveAndSendControl(emailPage) {
  for (const frame of emailPage.frames()) {
    const locators = [
      frame.locator("#emailPopupSaveButton").first(),
      frame.locator("a").filter({ has: frame.locator("img[src*='save_send.gif']") }).first(),
      frame.locator("img[src*='save_send.gif']").first(),
    ];

    for (const locator of locators) {
      if ((await locator.count().catch(() => 0)) > 0) {
        return {
          locator,
          frameName: frame.name() || null,
        };
      }
    }
  }

  return null;
}

async function waitForEmailBodyFrame(page) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => undefined);

    for (const frame of page.frames()) {
      const count = await frame.locator("textarea[name='EMAIL_TEMPLATE_BODY']").count().catch(() => 0);
      if (count > 0) {
        return frame;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error("Email body textarea EMAIL_TEMPLATE_BODY was not found.");
}

async function countSaveAndSendControls(page) {
  let total = 0;

  for (const frame of page.frames()) {
    const count = await frame.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll("a, button, input[type='button'], input[type='submit'], img")
      );
      return elements.filter((element) => {
        const label = [
          element.textContent,
          element.getAttribute("value"),
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
          element.getAttribute("src"),
          element.getAttribute("id"),
          element.getAttribute("href"),
        ]
          .filter(Boolean)
          .join(" ");
        return /save\s*(and|&)?\s*send|save_send\.gif|emailPopupSaveButton/i.test(label);
      }).length;
    }).catch(() => 0);

    total += count;
  }

  return total;
}

async function goToNextDocument(page) {
  if (await isLoginPage(page)) {
    await ensureLoggedIn(page, { reason: "before-next-document" });
    return false;
  }

  const submitted = await submitScholarOneLinkByImageAlt(page, /next\s+document|next_mss\.gif/i);
  if (!submitted) {
    return false;
  }

  const detailsReady = await waitForDetailsPageOrRelogin(page, "next-document");
  if (!detailsReady) {
    await logEvent("next_document_wait_failed", {
      message: "Login detected while waiting for next details page.",
      url: page.url(),
    });
    return false;
  }

  return true;
}

async function submitScholarOneLinkByImageAlt(page, pattern) {
  let submitted = false;
  try {
    submitted = await page.evaluate((source) => {
      const regex = new RegExp(source, "i");
      const form = document.forms[0];
      if (!form) {
        return false;
      }

      const images = Array.from(document.querySelectorAll("img"));
      const image = images.find((candidate) => {
        const label = [
          candidate.getAttribute("alt"),
          candidate.getAttribute("title"),
          candidate.getAttribute("src"),
        ]
          .filter(Boolean)
          .join(" ");
        return regex.test(label);
      });

      const link = image?.closest("a");
      if (!link) {
        return false;
      }

      const script = [
        link.getAttribute("href") || "",
        link.getAttribute("onclick") || "",
      ]
        .join(";")
        .replace(/^javascript:/i, "");

      if (!/set(DataAndNextPage|Field|NextPage)/i.test(script)) {
        return false;
      }

      for (const match of script.matchAll(/setField\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\)/g)) {
        setFormValue(match[1], decodeHtml(match[2]));
      }

      const dataAndNext = script.match(
        /setDataAndNextPage\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]+)['"]\)/
      );
      if (dataAndNext) {
        setFormValue(dataAndNext[1], decodeHtml(dataAndNext[2]));
        setFormValue("NEXT_PAGE", dataAndNext[3]);
        submitForm(form);
        return true;
      }

      return false;

      function setFormValue(name, value) {
        let field = form.elements[name];
        if (field && field.length && field.tagName === undefined) {
          field = field[0];
        }

        if (!field) {
          field = document.createElement("input");
          field.type = "hidden";
          field.name = name;
          form.appendChild(field);
        }

        field.value = value;
      }

      function submitForm(targetForm) {
        if (targetForm.elements.PAGE_LOADED_FLAG) {
          targetForm.elements.PAGE_LOADED_FLAG.value = "N";
        }
        if (window.getPostParams) {
          window.getPostParams();
        }
        targetForm.target = "";
        HTMLFormElement.prototype.submit.call(targetForm);
      }

      function decodeHtml(value) {
        const textarea = document.createElement("textarea");
        textarea.innerHTML = value;
        return textarea.value;
      }
    }, pattern.source);
  } catch (error) {
    submitted = /execution context|navigation|destroyed/i.test(error.message || "");
  }

  if (!submitted) {
    return false;
  }

  await Promise.race([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    page.waitForTimeout(12000),
  ]);
  return true;
}

async function returnToList(page) {
  if (await isLoginPage(page)) {
    await ensureLoggedIn(page, { reason: "return-to-list" });
    await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
    await ensureManuscriptListReady(page);
    return;
  }

  const before = page.url();
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  if (await isLoginPage(page)) {
    await ensureLoggedIn(page, { reason: "return-to-list-after-back" });
    await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
    await ensureManuscriptListReady(page);
    return;
  }

  if (page.url() !== before && (await countViewDetailsControls(page)) > 0) {
    return;
  }

  const backControls = [
    page.getByRole("link", { name: /back|return|manuscript list|dashboard/i }),
    page.getByRole("button", { name: /back|return|manuscript list|dashboard/i }),
  ];

  for (const locator of backControls) {
    if ((await locator.count().catch(() => 0)) > 0) {
      await Promise.all([
        waitForLikelyNavigation(page),
        locator.first().click(),
      ]);
      return;
    }
  }

  await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
  await ensureLoggedIn(page, { reason: "return-to-list-start-url" });
  await ensureManuscriptListReady(page);
}

function simpleHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

async function loadRejectTargets() {
  const ids = [...config.rejectIds];

  if (config.rejectFromReport) {
    const absolutePath = path.isAbsolute(config.rejectFromReport)
      ? config.rejectFromReport
      : path.join(projectRoot, config.rejectFromReport);
    const content = await fsp.readFile(absolutePath, "utf8");

    if (/\.csv$/i.test(absolutePath)) {
      ids.push(...extractCandidateIdsFromCsv(content));
    } else {
      ids.push(...extractCandidateIdsFromJson(JSON.parse(content)));
    }
  }

  return Array.from(new Set(ids.map(normalizeManuscriptId).filter(Boolean)));
}

function getRejectProgressPath(targets) {
  if (config.rejectProgressFile) {
    return path.isAbsolute(config.rejectProgressFile)
      ? config.rejectProgressFile
      : path.join(projectRoot, config.rejectProgressFile);
  }

  if (config.rejectFromReport) {
    const reportPath = path.isAbsolute(config.rejectFromReport)
      ? config.rejectFromReport
      : path.join(projectRoot, config.rejectFromReport);
    return reportPath.replace(/\.(json|csv)$/i, ".progress.json");
  }

  const hash = simpleHash(targets.join(","));
  return path.join(reportDir, `manual-targets-${hash}.progress.json`);
}

async function loadRejectProgress(progressPath, targets) {
  try {
    const content = await fsp.readFile(progressPath, "utf8");
    const progress = JSON.parse(content);
    progress.manuscripts ||= {};
    return progress;
  } catch {
    return {
      createdAt: new Date().toISOString(),
      updatedAt: null,
      sourceReport: config.rejectFromReport || null,
      targetCount: targets.length,
      manuscripts: {},
    };
  }
}

function getRejectProgressEntry(progress, manuscriptId) {
  return progress.manuscripts[normalizeManuscriptId(manuscriptId)] || null;
}

function isTerminalRejectProgress(status) {
  return [
    "sent",
    "not_actionable_no_reject_control",
  ].includes(status);
}

async function markRejectProgress(progress, progressPath, manuscriptId, entry) {
  const key = normalizeManuscriptId(manuscriptId);
  progress.updatedAt = new Date().toISOString();
  progress.sourceReport = config.rejectFromReport || progress.sourceReport || null;
  progress.manuscripts[key] = {
    manuscriptId: key,
    ...entry,
  };

  await fsp.mkdir(path.dirname(progressPath), { recursive: true });
  await fsp.writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}

function isNoRejectControlChecklistResult(checklistResult) {
  return checklistResult &&
    Number(checklistResult.rejectControlsFound || 0) === 0 &&
    /complete\s+checklist|reject|candidate|not\s+found|already/i.test(checklistResult.note || "");
}

function extractCandidateIdsFromJson(payload) {
  const candidates =
    payload?.result?.report?.candidates ||
    payload?.report?.candidates ||
    payload?.candidates ||
    [];

  if (Array.isArray(candidates)) {
    return candidates.map((entry) => entry?.manuscriptId).filter(Boolean);
  }

  return [];
}

function extractCandidateIdsFromCsv(content) {
  const rows = parseCsv(content);
  return rows
    .filter((row) =>
      /candidate/i.test(row.category || "") ||
      /would_reject/i.test(row.result || "")
    )
    .map((row) => row.manuscriptId)
    .filter(Boolean);
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }

  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

async function writeRunArtifacts(result) {
  const jsonPath = path.join(reportDir, `${runId}.json`);
  const csvPath = path.join(reportDir, `${runId}.csv`);
  const artifacts = {
    json: jsonPath,
    csv: csvPath,
  };
  const payload = {
    runId,
    createdAt: new Date().toISOString(),
    config: publicConfigSnapshot(),
    artifacts,
    result,
  };

  await fsp.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fsp.writeFile(csvPath, rowsToCsv(collectArtifactRows(result)), "utf8");

  return artifacts;
}

async function writeMetadataArtifact(result) {
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

function formatSingleAssessmentUsage(usage) {
  if (!usage?.available) return "brak danych o tokenach";
  return [
    `input=${usage.inputTokens}`,
    `cache=${usage.cachedInputTokens}`,
    `output=${usage.outputTokens}`,
    `reasoning=${usage.reasoningOutputTokens}`,
    `razem=${usage.totalTokens}`,
  ].join(", ");
}

function publicConfigSnapshot() {
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

function buildRunSummary(result) {
  const report = result.report || createReportSummary();
  const searchResults = result.results || [];
  return {
    checked: result.checked || 0,
    rejected: result.rejected || 0,
    wouldReject: report.candidates?.length || 0,
    skippedRevision: report.skippedRevision?.length || 0,
    skippedOther: report.skippedOther?.length || 0,
    manualReview: report.manualReview?.length || 0,
    targets: result.targets || null,
    searchSent: searchResults.filter((entry) => entry.status === "sent").length,
    searchWouldReject: searchResults.filter((entry) => entry.status === "would_reject").length,
    searchNotFound: searchResults.filter((entry) => entry.status === "not_found").length,
    searchAlreadyProcessed: searchResults.filter((entry) => entry.status === "already_processed").length,
    searchNotActionable: searchResults.filter((entry) => entry.status === "not_actionable_no_reject_control").length,
  };
}

function collectArtifactRows(result) {
  const rows = [];
  appendReportRows(rows, result.report, result.results ? "search-check" : "scan");

  for (const entry of result.results || []) {
    const details = entry.details || {};
    rows.push({
      runId,
      source: "search",
      category: entry.status || "",
      manuscriptId: entry.manuscriptId || details.manuscriptId || "",
      action: details.action || "",
      result: entry.status || "",
      reason: details.reason || entry.note || entry.progress?.status || entry.searchResult?.note || "",
      submittedDate: details.submittedDate || "",
      hasUnusualActivity: boolCsv(details.hasUnusualActivity),
      isRevision: boolCsv(details.isRevision),
      submittedMoreThanLimit: boolCsv(details.submittedMoreThanLimit),
    });
  }

  if (rows.length === 0) {
    rows.push({
      runId,
      source: "run",
      category: result.status || "",
      manuscriptId: "",
      action: "",
      result: result.status || "",
      reason: result.note || "",
      submittedDate: "",
      hasUnusualActivity: "",
      isRevision: "",
      submittedMoreThanLimit: "",
    });
  }

  return rows;
}

function appendReportRows(rows, report, source) {
  if (!report) {
    return;
  }

  const categories = [
    ["candidate", report.candidates || []],
    ["skippedRevision", report.skippedRevision || []],
    ["skippedOther", report.skippedOther || []],
    ["manualReview", report.manualReview || []],
  ];

  for (const [category, entries] of categories) {
    for (const entry of entries) {
      rows.push({
        runId,
        source,
        category,
        manuscriptId: entry.manuscriptId || "",
        action: entry.action || "",
        result: category === "candidate" ? "would_reject" : "skip",
        reason: entry.reason || "",
        submittedDate: entry.submittedDate || "",
        hasUnusualActivity: boolCsv(entry.hasUnusualActivity),
        isRevision: boolCsv(entry.isRevision),
        submittedMoreThanLimit: boolCsv(entry.submittedMoreThanLimit),
      });
    }
  }
}

function rowsToCsv(rows) {
  const headers = [
    "runId",
    "source",
    "category",
    "manuscriptId",
    "action",
    "result",
    "reason",
    "submittedDate",
    "hasUnusualActivity",
    "isRevision",
    "submittedMoreThanLimit",
  ];
  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function boolCsv(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return value ? "true" : "false";
}

async function logEvent(type, payload) {
  await fsp.mkdir(config.logsDir, { recursive: true });
  const line = JSON.stringify({
    type,
    at: new Date().toISOString(),
    ...payload,
  });
  await fsp.appendFile(logFile, `${line}\n`, "utf8");
}

function parseIdList(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeManuscriptId);
}

function hasMaxRejectedLimit() {
  return Number.isFinite(config.maxRejected) && config.maxRejected > 0;
}

function formatRejectedProgress(rejected) {
  return hasMaxRejectedLimit() ? `${rejected}/${config.maxRejected}` : `${rejected}`;
}
