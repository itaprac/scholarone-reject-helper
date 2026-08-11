import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyReviewerStatus,
  countReviewersTowardTarget,
  parseListRange,
  reviewerNeedsReplacement,
  samePerson,
  selectUniqueCandidates,
} from "./reviewer-rules.js";
import { REVIEWER_SELECTORS } from "./reviewer-selectors.js";
import { isRevisionManuscriptId } from "./manuscript-rules.js";
import { hasUnusualActivityAlert } from "./screening-metadata.js";
import { createScreenshotWriter } from "./core/screenshots.js";
import { pruneLogs } from "./core/log-retention.js";
import { createBrowserSession } from "./core/browser.js";
import {
  activateLinkByText,
  clickTextControl,
  evaluateAfterNavigation,
  hasVisibleTextControl,
  submitScholarOneLinkByText,
  waitForCondition,
  waitForVisibleTextControl,
} from "./core/dom.js";
import {
  ensureHeaderSearchReady,
  openManageMenu,
  waitForNavigation,
} from "./core/navigation.js";
import {
  loadEnvFile,
  loadLoginCredentials,
  nonNegativeInteger,
  parseArgs,
  parseBool,
  positiveInteger,
} from "./core/env.js";
import { createLogger, waitUntilInterrupted } from "./core/logger.js";
import { createRunStatus } from "./core/run-status.js";
import { readLoginFailureText } from "./core/login.js";
import { TIMEOUTS } from "./core/timeouts.js";
import {
  currentPaginationValue,
  detectReviewerPageState,
  readPagination,
  isReviewerQueuePage,
  navigatePagination,
  publicPerson,
  publicReviewer,
  readAllReviewerList,
  readCandidatePage,
  readManuscriptIdentity,
  readReviewerPage,
  summarizeReviewerList,
  waitForReviewerArticle,
  waitForReviewerListReady,
} from "./reviewers/page.js";
import {
  addReviewersToTarget,
  requestReviewerSearchRefresh,
  candidateAddConfirmationState,
  createAccountBlockingReason,
  findMatchingSimilarAccount,
  isReviewerCandidateShortage,
  isReviewerCandidateSkipped,
  readExistingEmailConflict,
} from "./reviewers/candidates.js";
import {
  clickFinalInviteAll,
  confirmInvitationsSent,
  extractPopWindowTarget,
  openInviteAllPopup,
  readArticleCounters,
  reviewersPendingInvitation,
} from "./reviewers/invitations.js";

// Re-eksport zachowuje dotychczasowe punkty wejścia modułu.
export {
  candidateAddConfirmationState,
  clickFinalInviteAll,
  confirmInvitationsSent,
  createAccountBlockingReason,
  currentPaginationValue,
  detectReviewerPageState,
  extractPopWindowTarget,
  findMatchingSimilarAccount,
  isReviewerCandidateShortage,
  isReviewerCandidateSkipped,
  readAllReviewerList,
  readCandidatePage,
  readExistingEmailConflict,
  readReviewerPage,
  reviewersPendingInvitation,
  waitForReviewerListReady,
};
import { DEFAULTS } from "./config/defaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

export async function runSelectReviewers(rawArgs = process.argv.slice(2)) {
  const args = parseArgs(rawArgs);
  const env = loadEnvFile(path.join(projectRoot, ".env"));
  const credentials = loadLoginCredentials(args, env);
  const config = buildConfig(args, env, credentials);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(config.logsDir, `select-reviewers-${runId}.jsonl`);
  const screenshotDir = path.join(config.logsDir, "screenshots", `select-reviewers-${runId}`);
  const writeLog = createLogger(logFile);
  const runStatus = createRunStatus({
    logsDir: config.logsDir,
    runId: `select-reviewers-${runId}`,
    pid: process.pid,
    mode: "reviewers",
    logFile: path.relative(projectRoot, logFile).split(path.sep).join("/"),
  });
  const log = async (type, payload = {}) => {
    await writeLog(type, payload);
    await runStatus(type, payload);
  };
  await runStatus("run_prepared", {});

  await fsp.mkdir(screenshotDir, { recursive: true });
  const screenshots = createScreenshotWriter({
    directory: screenshotDir,
    debug: config.debugScreenshots,
  });
  await pruneLogs({ logsDir: config.logsDir }).catch(() => undefined);
  await log("run_started", publicConfig(config));

  const session = await createBrowserSession(config);
  const { page } = session;
  page.setDefaultTimeout(TIMEOUTS.default);
  let batchIndex = 0;

  try {
    if (!config.cdp || page.url() === "about:blank") {
      await log("navigate_start", { url: config.startUrl });
      await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
    }

    await ensureLoggedIn(page, config, log);
    const results = [];
    const deferredReviewers = [];
    const skippedManuscriptIds = new Set();
    const processedManuscriptIds = new Set(config.initialExcludedManuscriptIds);
    let queueExhausted = false;

    for (batchIndex = 1; batchIndex <= config.maxManuscripts; batchIndex += 1) {
      await log("batch_manuscript_started", {
        batchIndex,
        requested: config.maxManuscripts,
        queueMode: config.reviewerQueueMode,
        queues: reviewerQueueLabels(config.reviewerQueueMode),
      });

      try {
        const result = await runBatchReviewerManuscript(page, {
          config,
          log,
          logFile,
          screenshots,
          batchIndex,
          excludedManuscriptIds: [
            ...deferredReviewers.map(({ manuscriptId }) => manuscriptId),
            ...skippedManuscriptIds,
            ...processedManuscriptIds,
          ],
        });
        if (isReviewerSearchDeferredResult(result)) {
          rememberDeferredReviewer(deferredReviewers, result, batchIndex);
        } else {
          results.push(result);
          rememberProcessedReviewerManuscript(processedManuscriptIds, result);
          if (isReviewerManuscriptSkippedResult(result)) {
            skippedManuscriptIds.add(result.manuscript.manuscriptId);
          }
        }
        await log("batch_manuscript_finished", {
          batchIndex,
          requested: config.maxManuscripts,
          status: result.status,
          manuscript: result.manuscript,
          deferred: deferredReviewers.length,
          skipped: skippedManuscriptIds.size,
        });

        if (
          !config.inviteAll &&
          !isReviewerSearchDeferredResult(result) &&
          !isReviewerManuscriptSkippedResult(result)
        ) break;
      } catch (error) {
        if ((batchIndex > 1 || deferredReviewers.length > 0) && isQueueExhaustedError(error)) {
          queueExhausted = true;
          await log("reviewer_queue_exhausted", {
            batchIndex,
            requested: config.maxManuscripts,
            completed: results.length,
            deferred: deferredReviewers.length,
            message: error.message,
          });
          break;
        }
        throw error;
      }

      await returnToReviewerStart(page, config, log, "batch_next_manuscript");
    }

    while (deferredReviewers.length > 0) {
      const pending = deferredReviewers.shift();
      await waitForReviewerRefresh(page, config, log, pending);
      await returnToReviewerStart(page, config, log, "deferred_reviewer_retry");

      const result = await runDeferredReviewerManuscript(page, {
        config,
        log,
        logFile,
        screenshots,
        batchIndex: pending.batchIndex,
        pending,
      });
      if (isReviewerSearchDeferredResult(result)) {
        rememberDeferredReviewer(deferredReviewers, result, pending.batchIndex, pending.attempts + 1);
      } else {
        results.push(result);
      }
      await log("deferred_reviewer_finished", {
        manuscriptId: pending.manuscriptId,
        attempt: pending.attempts,
        status: result.status,
        remaining: deferredReviewers.length,
      });
    }

    const result = config.maxManuscripts === 1 && results.length === 1
      ? results[0]
      : {
          status: "reviewer_batch_finished",
          requested: config.maxManuscripts,
          completed: results.length,
          skipped: skippedManuscriptIds.size,
          queueExhausted,
          deferred: deferredReviewers.length,
          results,
          logFile,
        };
    await log("run_finished", result);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const screenshot = await screenshots.error(page, `error-${batchIndex || 1}`);
    await log("run_failed", {
      message: error.message,
      stack: error.stack,
      url: page.url(),
      screenshot,
    });
    throw error;
  } finally {
    console.log(`\nLog: ${logFile}`);
    console.log(`Screenshots: ${screenshotDir}`);
    if (config.keepOpen) {
      console.log("Keep-open: przeglądarka pozostaje otwarta. Wciśnij Ctrl+C, aby zakończyć.");
      await waitUntilInterrupted();
    }
    await session.close();
  }
}

export function isReviewerSearchDeferredResult(result) {
  return result?.status === "reviewer_search_deferred";
}

export function isReviewerManuscriptSkippedResult(result) {
  return result?.status === "reviewer_manuscript_skipped";
}

export function isReviewerWaitingResult(result) {
  return result?.status === "reviewers_already_invited_waiting";
}

export function rememberProcessedReviewerManuscript(processed, result) {
  if (isReviewerSearchDeferredResult(result)) return false;
  const manuscriptId = result?.manuscript?.manuscriptId;
  if (!manuscriptId) return false;
  processed.add(manuscriptId);
  return true;
}

export function reviewerArticleSkipReason(bodyText) {
  return hasUnusualActivityAlert(bodyText) ? "unusual_activity_alert" : null;
}

export function rememberDeferredReviewer(queue, result, batchIndex, attempts = 1) {
  const manuscriptId = result?.manuscript?.manuscriptId;
  if (!manuscriptId) throw new Error("Nie można odroczyć artykułu bez manuscriptId.");
  const pending = {
    manuscriptId,
    manuscript: result.manuscript,
    batchIndex,
    attempts,
    countTowardTarget: result.countTowardTarget,
    target: result.target,
    refreshRequested: result.refreshRequested,
    reason: result.reason,
  };
  const existingIndex = queue.findIndex((item) => item.manuscriptId === manuscriptId);
  if (existingIndex >= 0) queue.splice(existingIndex, 1, pending);
  else queue.push(pending);
  return pending;
}

async function waitForReviewerRefresh(page, config, log, pending) {
  let remaining = config.refreshWaitMs;
  await log("deferred_reviewer_wait_started", {
    manuscriptId: pending.manuscriptId,
    attempt: pending.attempts,
    waitSeconds: Math.round(config.refreshWaitMs / 1000),
    reason: pending.reason,
  });
  while (remaining > 0) {
    const chunk = Math.min(remaining, 30_000);
    await page.waitForTimeout(chunk);
    remaining -= chunk;
    if (remaining > 0) {
      await log("deferred_reviewer_waiting", {
        manuscriptId: pending.manuscriptId,
        remainingSeconds: Math.ceil(remaining / 1000),
      });
    }
  }
}

async function runDeferredReviewerManuscript(page, options) {
  const { config, log, pending } = options;
  for (const queueLabel of reviewerQueueLabels("combined")) {
    try {
      return await runOneReviewerManuscript(page, {
        ...options,
        queueLabel,
        targetManuscriptId: pending.manuscriptId,
        recoveryAttempt: pending.attempts,
      });
    } catch (error) {
      if (!isQueueExhaustedError(error) && !isTargetManuscriptMissingError(error)) {
        if (canRecoverReviewerContext(error.reviewerContext)) {
          return recoverReviewerManuscript(page, options, error);
        }
        throw error;
      }
      await log("deferred_reviewer_queue_checked", {
        manuscriptId: pending.manuscriptId,
        attempt: pending.attempts,
        queueLabel,
        found: false,
      });
      await returnToReviewerStart(page, config, log, "deferred_reviewer_next_queue");
    }
  }

  await log("deferred_reviewer_still_refreshing", {
    manuscriptId: pending.manuscriptId,
    attempt: pending.attempts,
    reason: "not_visible_in_reviewer_queues",
  });
  return {
    status: "reviewer_search_deferred",
    manuscript: pending.manuscript,
    target: pending.target,
    countTowardTarget: pending.countTowardTarget,
    refreshRequested: false,
    reason: "not_visible_in_reviewer_queues",
    logFile: options.logFile,
  };
}

async function runBatchReviewerManuscript(page, options) {
  const { config, log, batchIndex } = options;
  let lastQueueError;

  for (const queueLabel of reviewerQueueLabels(config.reviewerQueueMode)) {
    try {
      return await runOneReviewerManuscript(page, { ...options, queueLabel });
    } catch (error) {
      if (config.reviewerQueueMode === "combined" && canRecoverReviewerContext(error.reviewerContext)) {
        return recoverReviewerManuscript(page, options, error);
      }
      if (config.reviewerQueueMode !== "combined" || !isQueueExhaustedError(error)) throw error;

      lastQueueError = error;
      await log("combined_queue_source_empty", { batchIndex, queueLabel, message: error.message });
      await returnToReviewerStart(page, config, log, "combined_queue_fallback");
    }
  }

  const error = new Error("Brak artykułów w Invite Reviewers ani Assign/Select Reviewers.");
  error.cause = lastQueueError;
  throw error;
}

async function recoverReviewerManuscript(page, options, originalError) {
  const { config, log, batchIndex } = options;
  const manuscriptId = originalError.reviewerContext.manuscriptId;
  let lastError = originalError;

  await log("reviewer_recovery_started", {
    batchIndex,
    manuscriptId,
    failedStage: originalError.reviewerContext.stage,
    failedQueue: originalError.reviewerContext.queueLabel,
    message: originalError.message,
  });

  for (let recoveryAttempt = 1; recoveryAttempt <= 2; recoveryAttempt += 1) {
    await returnToReviewerStart(page, config, log, "reviewer_recovery_login");

    for (const queueLabel of reviewerQueueLabels("combined")) {
      try {
        const result = await runOneReviewerManuscript(page, {
          ...options,
          queueLabel,
          targetManuscriptId: manuscriptId,
          recoveryAttempt,
        });
        await log("reviewer_recovery_succeeded", {
          batchIndex,
          manuscriptId,
          recoveryAttempt,
          queueLabel,
        });
        return result;
      } catch (error) {
        lastError = error;
        if (isQueueExhaustedError(error) || isTargetManuscriptMissingError(error)) {
          await log("reviewer_recovery_queue_checked", {
            batchIndex,
            manuscriptId,
            recoveryAttempt,
            queueLabel,
            found: false,
          });
          await returnToReviewerStart(page, config, log, "reviewer_recovery_next_queue");
          continue;
        }
        if (canRecoverReviewerContext(error.reviewerContext) && recoveryAttempt < 2) {
          await log("reviewer_recovery_retry", {
            batchIndex,
            manuscriptId,
            recoveryAttempt,
            stage: error.reviewerContext.stage,
            message: error.message,
          });
          break;
        }
        throw error;
      }
    }
  }

  const error = new Error(
    `Nie udało się wznowić ${manuscriptId} po ponownym logowaniu w Invite Reviewers ani Assign/Select Reviewers.`
  );
  error.cause = lastError;
  throw error;
}

async function returnToReviewerStart(page, config, log, reason) {
  if (page.isClosed()) throw new Error("Karta ScholarOne została zamknięta.");
  await page.bringToFront().catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  const state = await detectReviewerPageState(page);
  await log("reviewer_navigation_reused", { reason, state, url: page.url() });
  if (state === "login") {
    await ensureLoggedIn(page, config, log, reason);
  }
}

async function runOneReviewerManuscript(page, {
  config,
  log,
  logFile,
  screenshots,
  batchIndex,
  queueLabel,
  targetManuscriptId = null,
  recoveryAttempt = 0,
  excludedManuscriptIds = [],
}) {
  let stage = "opening_queue";
  let manuscript = null;

  try {
    await ensureReviewerQueue(page, config, log, queueLabel);
    const queueItem = await openReviewerArticle(
      page,
      log,
      queueLabel,
      targetManuscriptId,
      excludedManuscriptIds
    );
    await waitForReviewerArticle(page);

    manuscript = await readManuscriptIdentity(page);
    if (!manuscript.manuscriptId) {
      manuscript.manuscriptId = queueItem.rowText
        ?.match(/\b([A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?)\b/i)?.[1]
        ?.toUpperCase() || null;
    }
    stage = "reading_article";
    if (targetManuscriptId && manuscript.manuscriptId !== targetManuscriptId) {
      throw new Error(`Otworzono ${manuscript.manuscriptId || "nieznany artykuł"} zamiast ${targetManuscriptId}.`);
    }
    await log("article_opened", {
      ...manuscript,
      batchIndex,
      queueLabel,
      recoveryAttempt,
      queueItem,
      url: page.url(),
    });

    const skipReason = reviewerArticleSkipReason(await page.locator("body").innerText());
    if (skipReason) {
      const result = {
        status: "reviewer_manuscript_skipped",
        reason: skipReason,
        manuscript,
        queueLabel,
        logFile,
      };
      await log("reviewer_manuscript_skipped", result);
      return result;
    }

    const initialReviewers = await readAllReviewerList(page, log);
    const initialCount = countReviewersTowardTarget(initialReviewers);
    await log("reviewer_list_initial", summarizeReviewerList(initialReviewers, initialCount));

    const selectionPolicy = reviewerSelectionPolicy(
      manuscript.manuscriptId,
      queueLabel,
      initialReviewers
    );
    await log("reviewer_selection_policy", {
      manuscriptId: manuscript.manuscriptId,
      ...selectionPolicy,
      reviewersNeedingReplacement: initialReviewers
        .filter(reviewerNeedsReplacement)
        .map(publicReviewer),
    });

    stage = "selecting_reviewers";
    let selection;
    try {
      selection = selectionPolicy.addNewReviewers
        ? await addReviewersToTarget(page, {
          target: config.reviewersPerPaper,
          initialReviewers,
          log,
          refreshCurrentReviewerTask,
        })
        : { added: [], skipped: [], reviewers: initialReviewers };
    } catch (error) {
      if (!isReviewerCandidateShortage(error)) throw error;
      stage = "refreshing_reviewer_search";
      const refresh = await requestReviewerSearchRefresh(page, log, manuscript);
      const result = {
        status: "reviewer_search_deferred",
        manuscript,
        queueLabel,
        target: error.target,
        countTowardTarget: error.count,
        added: error.added.map(publicPerson),
        skipped: error.skipped.map(publicPerson),
        refreshRequested: refresh.requested,
        reason: refresh.reason,
        logFile,
      };
      await log("reviewer_search_deferred", result);
      return result;
    }

    const beforeInviteReviewers = await readAllReviewerList(page, log);
    const reviewersToInvite = reviewersPendingInvitation(beforeInviteReviewers);
    const beforeInviteCounters = await readArticleCounters(page);
    await log("selection_target_reached", {
      target: config.reviewersPerPaper,
      targetEnforced: selectionPolicy.addNewReviewers,
      policyReason: selectionPolicy.reason,
      added: selection.added.length,
      skipped: selection.skipped.map(publicPerson),
      countTowardTarget: countReviewersTowardTarget(beforeInviteReviewers),
      pendingInvitations: reviewersToInvite.length,
      counters: beforeInviteCounters,
      reviewers: beforeInviteReviewers.map(publicReviewer),
    });

    if (reviewersToInvite.length === 0) {
      const result = {
        status: "reviewers_already_invited_waiting",
        reason: "no_selected_reviewers_to_invite",
        manuscript,
        queueLabel,
        target: config.reviewersPerPaper,
        countTowardTarget: countReviewersTowardTarget(beforeInviteReviewers),
        counters: beforeInviteCounters,
        logFile,
      };
      await log("reviewer_invitation_not_required", result);
      return result;
    }

    stage = "opening_invite_popup";
    const invitePopup = await openInviteAllPopup(page, log);
    // Dowód stanu popupu tuż przed nieodwracalną wysyłką — zawsze na dysk.
    const popupScreenshot = await screenshots.proof(
      invitePopup,
      `before-final-invite-all-${batchIndex}`
    );

    if (!config.inviteAll) {
      const result = {
        status: "stopped_before_final_invite_all",
        manuscript,
        target: config.reviewersPerPaper,
        added: selection.added.map(publicPerson),
        skipped: selection.skipped.map(publicPerson),
        countTowardTarget: countReviewersTowardTarget(beforeInviteReviewers),
        popupScreenshot,
        logFile,
        note: "Pierwszy Invite All otworzył popup. Drugi, wysyłający Invite All nie został kliknięty. Dodaj --invite-all, aby jawnie zezwolić na wysłanie.",
      };
      await log("safety_stop_before_final_invite_all", result);
      return result;
    }

    stage = "sending_invitations";
    const sendResult = await clickFinalInviteAll(invitePopup, log);
    stage = "verifying_invitations";
    await restoreReviewerArticleAfterInvite(page, {
      config,
      log,
      manuscriptId: manuscript.manuscriptId,
    });

    const afterInviteReviewers = await readAllReviewerList(page, log);
    const afterInviteCounters = await readArticleCounters(page);
    const confirmation = confirmInvitationsSent({
      beforeCounters: beforeInviteCounters,
      afterCounters: afterInviteCounters,
      afterReviewers: afterInviteReviewers,
      expected: reviewersToInvite,
    });
    await log("invite_all_verification", confirmation);

    if (!confirmation.confirmed) {
      throw new Error(
        "Finalny Invite All został wykonany, ale po odświeżeniu nie ma wystarczającego potwierdzenia w statusach/licznikach. Sprawdź artykuł ręcznie."
      );
    }

    return {
      status: "invite_all_confirmed",
      manuscript,
      queueLabel,
      target: config.reviewersPerPaper,
      added: selection.added.map(publicPerson),
      skipped: selection.skipped.map(publicPerson),
      sendResult,
      confirmation,
      logFile,
    };
  } catch (error) {
    error.reviewerContext ||= {
      stage,
      manuscriptId: manuscript?.manuscriptId || targetManuscriptId,
      queueLabel,
    };
    throw error;
  }
}

async function restoreReviewerArticleAfterInvite(page, { config, log, manuscriptId }) {
  await page.bringToFront().catch(() => undefined);
  // ScholarOne refreshes the opener asynchronously after the popup closes. The
  // page can remain a blank/partial shell for over ten seconds, especially with
  // slowMo. Do not navigate away: a sent manuscript is expected to disappear
  // from both reviewer work queues.
  const automatic = await waitForReviewerArticleIdentity(page, manuscriptId, 45_000);
  await log("reviewer_restore_state", {
    manuscriptId,
    state: automatic.state,
    observedStates: automatic.observedStates,
    automaticRefresh: automatic.ready,
    url: page.url(),
  });
  if (automatic.ready) return;

  if (automatic.state === "login") {
    await ensureLoggedIn(page, config, log, "after_invite");
  }

  await ensureAdminCenter(page, config, log, "after_invite_quick_search");
  const quickSearchResult = await openReviewerArticleFromQuickSearch(page, manuscriptId, log);
  if (quickSearchResult.opened) {
    await log("reviewer_article_reopened_after_invite", {
      manuscriptId,
      method: quickSearchResult.method,
      url: page.url(),
    });
    return;
  }
  throw new Error(
    `Zaproszenia zostały wysłane, ale nie udało się ponownie otworzyć ${manuscriptId} przez Quick Search do bezpiecznej weryfikacji (${quickSearchResult.reason || "nieznany błąd"}).`
  );
}

export async function waitForReviewerArticleIdentity(page, manuscriptId, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  const observedStates = [];
  let lastState = null;
  let stableTerminalStateCount = 0;

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("Karta ScholarOne została zamknięta podczas weryfikacji zaproszeń.");
    await page.waitForLoadState("domcontentloaded", { timeout: 1_000 }).catch(() => undefined);
    const state = await detectReviewerPageState(page);
    if (state !== lastState) observedStates.push(state);
    stableTerminalStateCount = state === lastState && state === "login"
      ? stableTerminalStateCount + 1
      : 0;
    lastState = state;

    if (state === "reviewer_article") {
      const current = await readManuscriptIdentity(page);
      if (current.manuscriptId !== manuscriptId) {
        throw new Error(`Po Invite All otwarto ${current.manuscriptId || "inny manuskrypt"} zamiast ${manuscriptId}.`);
      }
      return { ready: true, state, observedStates };
    }
    if (stableTerminalStateCount >= 8) break;
    await page.waitForTimeout(500).catch(() => undefined);
  }
  return { ready: false, state: lastState || "unknown", observedStates };
}

async function refreshCurrentReviewerTask(page, log, reason) {
  const submitted = await submitScholarOneLinkByText(
    page,
    /^(?:invite|select)\s+reviewers$/i,
    /MANUSCRIPT_DETAILS_SHOW_TAB/i
  );
  if (!submitted) return false;

  try {
    await waitForReviewerArticle(page, 20_000);
    await log("reviewer_article_refreshed", {
      reason,
      method: "reviewer_task_form_submit",
      url: page.url(),
    });
    return true;
  } catch (error) {
    await log("reviewer_article_refresh_failed", {
      reason,
      message: error.message,
      state: await detectReviewerPageState(page),
      url: page.url(),
    });
    return false;
  }
}

function isQueueExhaustedError(error) {
  return /Nie znaleziono linku (Assign|Select|Invite) Reviewers|Kolejka nie zawiera pozycji Select|Brak artykułów (?:w|zarówno)/i
    .test(error?.message || "");
}

function isTargetManuscriptMissingError(error) {
  return /Nie znaleziono manuskryptu .+ w kolejce (Select|Invite) Reviewers/i
    .test(error?.message || "");
}

export function reviewerQueueLabels(mode) {
  // Nazwa drugiej kolejki zależy od konfiguracji ScholarOne: starszy layout
  // używa "Select Reviewers", a bieżący KES pokazuje "Assign Reviewers".
  // Traktujemy je jako aliasy tej samej fazy i próbujemy aktualną nazwę pierwszą.
  if (mode === "combined") return ["Invite Reviewers", "Assign Reviewers", "Select Reviewers"];
  if (mode === "invite") return ["Invite Reviewers"];
  if (mode === "select") return ["Assign Reviewers", "Select Reviewers"];
  throw new Error(`Nieznany tryb kolejki reviewerów: ${mode}`);
}

export function reviewerSelectionPolicy(manuscriptId, queueLabel, reviewers) {
  const isRevision = isRevisionManuscriptId(manuscriptId);
  const isInviteQueue = queueLabel === "Invite Reviewers";
  const hasReviewerNeedingReplacement = reviewers.some(reviewerNeedsReplacement);

  if (isRevision) {
    return {
      isRevision,
      isInviteQueue,
      addNewReviewers: hasReviewerNeedingReplacement,
      reason: hasReviewerNeedingReplacement
        ? "revision_has_reviewer_needing_replacement"
        : "revision_reuses_existing_reviewers",
    };
  }

  return {
    isRevision,
    isInviteQueue,
    addNewReviewers: true,
    reason: !isInviteQueue
      ? "select_reviewers_queue_fills_target"
      : "original_submission_fills_reviewer_target",
  };
}

export function canRecoverReviewerContext(context) {
  return Boolean(context?.manuscriptId) && [
    "reading_article",
    "selecting_reviewers",
    "opening_invite_popup",
  ].includes(context.stage);
}

function buildConfig(args, env, credentials) {
  const legacyResume = parseBool(args["resume-invite-reviewers"], false);
  const reviewerQueueMode = String(
    args["reviewer-queue"] || (legacyResume ? "invite" : "select")
  ).trim().toLowerCase();
  reviewerQueueLabels(reviewerQueueMode);
  const config = {
    startUrl: args["start-url"] || env.START_URL || DEFAULTS.startUrl,
    reviewersPerPaper: positiveInteger(
      args["reviewers-per-paper"] || env.REVIEWERS_PER_PAPER,
      10,
      "--reviewers-per-paper"
    ),
    maxManuscripts: positiveInteger(args["max-manuscripts"], 1, "--max-manuscripts"),
    inviteAll: parseBool(args["invite-all"], false),
    reviewerQueueMode,
    resumeInviteReviewers: reviewerQueueMode === "invite",
    initialExcludedManuscriptIds: String(args["exclude-manuscript-ids"] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    headless: parseBool(args.headless ?? env.HEADLESS, false),
    headed: args.headed === true,
    browserChannel: args["browser-channel"] || env.BROWSER_CHANNEL || "",
    cdp: args.cdp || env.CDP || "",
    slowMo: nonNegativeInteger(args["slow-mo"] || env.SLOW_MO, 0, "--slow-mo"),
    refreshWaitMs: positiveInteger(
      args["refresh-wait-seconds"] || env.REVIEWER_REFRESH_WAIT_SECONDS,
      60,
      "--refresh-wait-seconds"
    ) * 1000,
    keepOpen: parseBool(args["keep-open"] ?? env.KEEP_OPEN, false),
    debugScreenshots: parseBool(args["debug-screenshots"] ?? env.DEBUG_SCREENSHOTS, false),
    autoLogin: parseBool(
      args["auto-login"] ?? env.AUTO_LOGIN,
      Boolean(credentials.username && credentials.password)
    ),
    username: credentials.username,
    password: credentials.password,
    profileDir: args["profile-dir"] || path.join(projectRoot, "playwright-profile"),
    logsDir: args["logs-dir"] || path.join(projectRoot, "logs"),
  };
  if (config.maxManuscripts > 1 && !config.inviteAll) {
    throw new Error("--max-manuscripts większe niż 1 wymaga jawnej flagi --invite-all.");
  }
  if (config.headed) config.headless = false;
  return config;
}

async function ensureLoggedIn(page, config, log, reason = "unknown") {
  if (!(await isLoginPage(page))) {
    await log("login_not_required", { reason, url: page.url() });
    return;
  }

  if (config.autoLogin && config.username && config.password) {
    await log("auto_login_started", { reason, url: page.url() });
    const username = page.locator("#USERID").first();
    const password = page.locator("#PASSWORD").first();
    const login = page.locator("#logInButton").first();
    const knownSelectorsReady = await username.isVisible({ timeout: 2_000 }).catch(() => false) &&
      await password.isVisible({ timeout: 2_000 }).catch(() => false) &&
      await login.isVisible({ timeout: 2_000 }).catch(() => false);

    if (knownSelectorsReady) {
      await username.click({ timeout: 5_000 }).catch(() => undefined);
      await username.fill(config.username);
      await password.click({ timeout: 5_000 }).catch(() => undefined);
      await password.fill(config.password);

      let clickedWith = "playwright";
      try {
        await login.click({ timeout: 5_000 });
      } catch {
        clickedWith = "dom_fallback";
        await page.evaluate(() => {
          const button = document.querySelector("#logInButton");
          if (!button) return false;
          button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          button.click();
          return true;
        }).catch(() => false);
      }

      let loggedIn = await waitForReviewerLoggedIn(page, 15_000);
      let pressedEnterFallback = false;
      if (!loggedIn) {
        pressedEnterFallback = true;
        await password.press("Enter").catch(() => page.keyboard.press("Enter").catch(() => undefined));
        loggedIn = await waitForReviewerLoggedIn(page, 10_000);
      }

      await log("auto_login_attempted", {
        reason,
        clickedWith,
        pressedEnterFallback,
        loggedIn,
        url: page.url(),
      });
      if (loggedIn || !(await isLoginPage(page))) {
        await log("auto_login_succeeded", { reason, url: page.url() });
        return;
      }
    }
    await log("auto_login_failed", {
      reason,
      knownSelectorsReady,
      url: page.url(),
      failureText: await readLoginFailureText(page),
    });
  }

  console.log("Zaloguj się ręcznie w otwartym oknie ScholarOne; automat czeka maksymalnie 5 minut.");
  await log("manual_login_wait_started", { reason, url: page.url() });
  if (!(await waitForReviewerLoggedIn(page, 5 * 60 * 1000))) {
    throw new Error("Nie potwierdzono logowania do ScholarOne w ciągu 5 minut.");
  }
  await log("manual_login_succeeded", { reason, url: page.url() });
}

async function isLoginPage(page) {
  return (await detectReviewerPageState(page)) === "login";
}

async function waitForReviewerLoggedIn(page, timeout) {
  return page.waitForFunction(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    const passwordVisible = Array.from(document.querySelectorAll("input[type='password']")).some(visible);
    const loggedInMarker = /log\s*out|admin\s+(?:center|dashboard)|(?:assign|select|invite)\s+reviewers|view\s+details/i.test(text) ||
      Boolean(document.querySelector("#QUICK_SEARCH_HEADER_SEARCH_TEXT"));
    return loggedInMarker && !passwordVisible;
  }, null, { timeout }).then(() => true).catch(() => false);
}

async function ensureReviewerQueue(page, config, log, queueLabel) {
  const queuePattern = new RegExp(`^${queueLabel.replace(/\s+/g, "\\s+")}$`, "i");
  const queueType = queueLabel.toLowerCase().replace(/\s+/g, "_");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await ensureLoggedIn(page, config, log, `reviewer_queue_${queueType}`);

  if (await isReviewerQueuePage(page, queueLabel)) {
    await log("reviewer_queue_ready", { queueLabel, queueType, source: "current_page", url: page.url() });
    return;
  }

  await ensureAdminCenter(page, config, log, `reviewer_queue_${queueType}`);
  const queueVisible = await waitForVisibleTextControl(page, queuePattern, 12_000);
  if (!queueVisible) throw new Error(`Nie znaleziono linku ${queueLabel} w Admin Center.`);
  if (!(await activateLinkByText(page, queuePattern)) &&
      !(await clickTextControl(page, queuePattern))) {
    throw new Error(`Nie udało się aktywować kolejki ${queueLabel} w Admin Center.`);
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  await waitForReviewerQueue(page, queueLabel, 15_000);
  await log("reviewer_queue_ready", {
    queueLabel,
    queueType,
    source: "admin_center",
    url: page.url(),
    items: await page.locator(REVIEWER_SELECTORS.queueAction).count(),
  });
}

async function ensureAdminCenter(page, config, log, reason) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
  await ensureLoggedIn(page, config, log, reason);
  if ((await detectReviewerPageState(page)) === "admin_center") {
    await log("admin_center_ready", { reason, source: "current_page", url: page.url() });
    return;
  }

  await log("navigate_admin_center_started", { reason, url: page.url() });
  let adminActivated = (await detectReviewerPageState(page)) === "admin_center";
  if (!adminActivated) {
    adminActivated = await submitScholarOneLinkByText(
      page,
      /^admin\s+center$/i,
      /DASHBOARD|XIK_CUR_ROLE_ID/i
    );
  }
  if (!adminActivated && await hasVisibleTextControl(page, /^admin\s+center$/i)) {
    adminActivated ||= await activateLinkByText(page, /^admin\s+center$/i) ||
      await clickTextControl(page, /^admin\s+center$/i);
  } else if (!adminActivated) {
    const manageOpened = await openManageMenu(page);
    await log("manage_menu_attempted", {
      manageOpened,
      adminCenterVisible: await hasVisibleTextControl(page, /^admin\s+center$/i),
    });
    if (manageOpened) {
      adminActivated = await activateLinkByText(page, /^admin\s+center$/i) ||
        await clickTextControl(page, /^admin\s+center$/i);
    }
  }

  if (!adminActivated) {
    throw new Error("Nie udało się otworzyć Admin Center z menu Manage.");
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && (await detectReviewerPageState(page)) !== "admin_center") {
    if (await isLoginPage(page)) await ensureLoggedIn(page, config, log, `${reason}_admin_center`);
    await page.waitForTimeout(250);
  }
  if ((await detectReviewerPageState(page)) !== "admin_center") {
    throw new Error("Admin Center został aktywowany, ale strona Admin Center nie załadowała się poprawnie.");
  }
  await log("admin_center_ready", { reason, source: "navigation", url: page.url() });
}

async function waitForReviewerQueue(page, queueLabel, timeout) {
  let expired = false;
  const opened = await waitForCondition(page, async () => {
    if (await isReviewerQueuePage(page, queueLabel)) return true;
    // Wygaśnięcie sesji przerywa czekanie od razu — dalsze odpytywanie i tak by
    // nic nie dało, a komunikat ma wskazać prawdziwą przyczynę.
    if (await isLoginPage(page)) {
      expired = true;
      return true;
    }
    return false;
  }, { timeout });

  if (expired) {
    throw new Error(`Sesja wygasła podczas otwierania kolejki ${queueLabel}.`);
  }
  if (!opened) {
    throw new Error(`ScholarOne nie otworzył właściwej kolejki ${queueLabel}.`);
  }
}

async function openReviewerArticleFromQuickSearch(page, manuscriptId, log) {
  if (!(await ensureHeaderSearchReady(page))) {
    return { opened: false, reason: "quick_search_not_available" };
  }

  const input = page.locator("#QUICK_SEARCH_HEADER_SEARCH_TEXT").first();
  const button = page.locator("#btn_search").first();
  await input.fill("");
  await input.fill(manuscriptId);
  const navigation = waitForNavigation(page, 15_000);
  await button.click({ timeout: 5_000 }).catch(() => input.press("Enter"));
  await navigation;

  if (await isLoginPage(page)) return { opened: false, reason: "login_after_quick_search" };
  if ((await detectReviewerPageState(page)) === "reviewer_article") {
    const current = await readManuscriptIdentity(page);
    return { opened: current.manuscriptId === manuscriptId, method: "quick_search_direct" };
  }

  await page.waitForFunction(({ selector, targetId }) => {
    const normalize = (value) => (value || "").toUpperCase().replace(/\s+/g, "");
    return normalize(document.body?.innerText).includes(normalize(targetId)) &&
      Boolean(document.querySelector(selector));
  }, { selector: REVIEWER_SELECTORS.queueAction, targetId: manuscriptId }, {
    timeout: 15_000,
  }).catch(() => undefined);

  const action = await findQuickSearchReviewerAction(page, manuscriptId);
  if (!action) return { opened: false, reason: "reviewer_action_not_found" };

  await log("reviewer_quick_search_action_selected", { manuscriptId, action });
  const actionLocator = page.locator(REVIEWER_SELECTORS.queueAction).nth(action.index);
  const actionNavigation = waitForNavigation(page, 15_000);
  await actionLocator.selectOption(action.value);
  await actionNavigation;

  if (action.label === "View Details") {
    const submitted = await submitScholarOneLinkByText(
      page,
      /^invite\s+reviewers$/i,
      /MANUSCRIPT_DETAILS_SHOW_TAB/i
    );
    if (!submitted) return { opened: false, reason: "reviewer_tab_not_found_after_details" };
  }

  await waitForReviewerArticle(page, 20_000);
  const current = await readManuscriptIdentity(page);
  return {
    opened: current.manuscriptId === manuscriptId,
    method: `quick_search_${action.label.toLowerCase().replace(/\s+/g, "_")}`,
  };
}

async function findQuickSearchReviewerAction(page, manuscriptId) {
  return page.evaluate(({ selector, targetId }) => {
    const normalize = (value) => (value || "").toUpperCase().replace(/\s+/g, "");
    const target = normalize(targetId);
    const actions = Array.from(document.querySelectorAll(selector));
    for (let index = 0; index < actions.length; index += 1) {
      const select = actions[index];
      const rowText = normalize(select.closest("tr")?.innerText || select.closest("tr")?.textContent);
      if (!rowText.includes(target)) continue;
      const preferredLabels = ["Invite Reviewers", "Assign Reviewers", "Select Reviewers", "View Details"];
      for (const label of preferredLabels) {
        const option = Array.from(select.options).find((candidate) =>
          (candidate.textContent || "").replace(/\s+/g, " ").trim() === label
        );
        if (option) return { index, value: option.value, label };
      }
    }
    return null;
  }, { selector: REVIEWER_SELECTORS.queueAction, targetId: manuscriptId }).catch(() => null);
}

async function openReviewerArticle(
  page,
  log,
  queueLabel,
  targetManuscriptId = null,
  excludedManuscriptIds = []
) {
  const scanAllPages = Boolean(targetManuscriptId || excludedManuscriptIds.length);
  const pagination = scanAllPages
    ? await readPagination(page, REVIEWER_SELECTORS.queuePagination)
    : null;
  const originalPageValue = pagination?.value || null;
  const pageValues = scanAllPages && pagination?.options?.length
    ? [...new Set([
      originalPageValue,
      ...pagination.options.map(({ value }) => value),
    ].filter(Boolean))]
    : [null];

  for (const pageValue of pageValues) {
    const currentPageValue = await currentPaginationValue(
      page,
      REVIEWER_SELECTORS.queuePagination
    );
    if (pageValue && currentPageValue !== pageValue) {
      await navigatePagination(page, REVIEWER_SELECTORS.queuePagination, pageValue);
    }

    const selected = await openReviewerArticleOnCurrentQueuePage(
      page,
      log,
      queueLabel,
      targetManuscriptId,
      pageValue || currentPageValue,
      excludedManuscriptIds
    );
    if (selected) return selected;
  }

  if (targetManuscriptId && originalPageValue) {
    const currentPageValue = await currentPaginationValue(
      page,
      REVIEWER_SELECTORS.queuePagination
    );
    if (currentPageValue !== originalPageValue) {
      await navigatePagination(
        page,
        REVIEWER_SELECTORS.queuePagination,
        originalPageValue
      ).catch(async (error) => {
        await log("queue_page_restore_failed", {
          queueLabel,
          originalPageValue,
          message: error.message,
        });
      });
    }
  }

  if (targetManuscriptId) {
    throw new Error(`Nie znaleziono manuskryptu ${targetManuscriptId} w kolejce ${queueLabel}.`);
  }
  throw new Error(`Kolejka nie zawiera pozycji Select → ${queueLabel}.`);
}

async function openReviewerArticleOnCurrentQueuePage(
  page,
  log,
  queueLabel,
  targetManuscriptId,
  pageValue,
  excludedManuscriptIds
) {
  const optionPattern = new RegExp(`^${queueLabel.replace(/\s+/g, "\\s+")}$`, "i");
  const actions = page.locator(REVIEWER_SELECTORS.queueAction);
  const count = await actions.count();
  for (let index = 0; index < count; index += 1) {
    const action = actions.nth(index);
    const options = await action.locator("option").evaluateAll((items) => items.map((option) => ({
      text: (option.textContent || "").replace(/\s+/g, " ").trim(),
      value: option.value,
    })));
    const target = options.find(({ text }) => optionPattern.test(text));
    if (!target) continue;

    const rowText = await action.evaluate((select) =>
      (select.closest("tr")?.innerText || select.closest("tr")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (targetManuscriptId && !rowText.toUpperCase().includes(targetManuscriptId.toUpperCase())) {
      continue;
    }
    const excludedManuscriptId = excludedManuscriptIds.find((manuscriptId) =>
      rowText.toUpperCase().includes(manuscriptId.toUpperCase())
    );
    if (excludedManuscriptId) {
      await log("queue_article_skipped_deferred", {
        queueLabel,
        pageValue,
        manuscriptId: excludedManuscriptId,
      });
      continue;
    }
    await log("queue_article_selected", {
      queueLabel,
      index,
      pageValue,
      optionValue: target.value,
      rowText,
      targetManuscriptId,
    });
    const navigation = waitForNavigation(page, 15_000);
    await action.selectOption(target.value);
    await navigation;
    return { index, pageValue, rowText };
  }
  await log("queue_page_scanned", {
    queueLabel,
    pageValue,
    targetManuscriptId,
    excludedManuscriptIds,
    items: count,
    found: false,
  });
  return null;
}

function publicConfig(config) {
  return {
    startUrl: config.startUrl,
    reviewersPerPaper: config.reviewersPerPaper,
    maxManuscripts: config.maxManuscripts,
    inviteAll: config.inviteAll,
    reviewerQueueMode: config.reviewerQueueMode,
    resumeInviteReviewers: config.resumeInviteReviewers,
    headless: config.headless,
    browserChannel: config.browserChannel || "playwright-chromium",
    cdp: config.cdp || null,
    slowMo: config.slowMo,
    refreshWaitSeconds: Math.round(config.refreshWaitMs / 1000),
    keepOpen: config.keepOpen,
    autoLogin: config.autoLogin,
    hasLoginCredentials: Boolean(config.username && config.password),
  };
}
