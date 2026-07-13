import { chromium } from "playwright";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyReviewerStatus,
  countReviewersTowardTarget,
  parseListRange,
  samePerson,
  selectUniqueCandidates,
} from "./reviewer-rules.js";
import { REVIEWER_SELECTORS } from "./reviewer-selectors.js";

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
  const log = createLogger(logFile);

  await fsp.mkdir(screenshotDir, { recursive: true });
  await log("run_started", publicConfig(config));

  const session = await createBrowserSession(config);
  const { page } = session;
  page.setDefaultTimeout(15_000);
  let batchIndex = 0;

  try {
    if (!config.cdp || page.url() === "about:blank") {
      await log("navigate_start", { url: config.startUrl });
      await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
    }

    await ensureLoggedIn(page, config, log);
    const results = [];
    const deferredReviewers = [];
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
          screenshotDir,
          batchIndex,
          excludedManuscriptIds: deferredReviewers.map(({ manuscriptId }) => manuscriptId),
        });
        if (isReviewerSearchDeferredResult(result)) {
          rememberDeferredReviewer(deferredReviewers, result, batchIndex);
        } else {
          results.push(result);
        }
        await log("batch_manuscript_finished", {
          batchIndex,
          requested: config.maxManuscripts,
          status: result.status,
          manuscript: result.manuscript,
          deferred: deferredReviewers.length,
        });

        if (!config.inviteAll && !isReviewerSearchDeferredResult(result)) break;
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

      await log("batch_return_to_start", { batchIndex, url: config.startUrl });
      await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
      await ensureLoggedIn(page, config, log);
    }

    while (deferredReviewers.length > 0) {
      const pending = deferredReviewers.shift();
      await waitForReviewerRefresh(page, config, log, pending);
      await returnToReviewerStart(page, config, log, "deferred_reviewer_retry");

      const result = await runDeferredReviewerManuscript(page, {
        config,
        log,
        logFile,
        screenshotDir,
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
          queueExhausted,
          deferred: deferredReviewers.length,
          results,
          logFile,
        };
    await log("run_finished", result);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const screenshot = await saveScreenshot(page, screenshotDir, `error-${batchIndex || 1}`);
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
  for (const queueLabel of ["Invite Reviewers", "Select Reviewers"]) {
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

  const error = new Error("Brak artykułów zarówno w Invite Reviewers, jak i Select Reviewers.");
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

    for (const queueLabel of ["Invite Reviewers", "Select Reviewers"]) {
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
    `Nie udało się wznowić ${manuscriptId} po ponownym logowaniu w Invite Reviewers ani Select Reviewers.`
  );
  error.cause = lastError;
  throw error;
}

async function returnToReviewerStart(page, config, log, reason) {
  await log("reviewer_return_to_start", { reason, url: config.startUrl });
  await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
  await ensureLoggedIn(page, config, log);
}

async function runOneReviewerManuscript(page, {
  config,
  log,
  logFile,
  screenshotDir,
  batchIndex,
  queueLabel,
  targetManuscriptId = null,
  recoveryAttempt = 0,
  excludedManuscriptIds = [],
}) {
  let stage = "opening_queue";
  let manuscript = null;

  try {
    await ensureReviewerQueue(page, log, queueLabel);
    const queueItem = await openReviewerArticle(
      page,
      log,
      queueLabel,
      targetManuscriptId,
      excludedManuscriptIds
    );
    await waitForReviewerArticle(page);

    manuscript = await readManuscriptIdentity(page);
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

    const initialReviewers = await readAllReviewerList(page, log);
    const initialCount = countReviewersTowardTarget(initialReviewers);
    await log("reviewer_list_initial", summarizeReviewerList(initialReviewers, initialCount));

    stage = "selecting_reviewers";
    let selection;
    try {
      selection = await addReviewersToTarget(page, {
        target: config.reviewersPerPaper,
        initialReviewers,
        log,
      });
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
      added: selection.added.length,
      skipped: selection.skipped.map(publicPerson),
      countTowardTarget: countReviewersTowardTarget(beforeInviteReviewers),
      pendingInvitations: reviewersToInvite.length,
      counters: beforeInviteCounters,
      reviewers: beforeInviteReviewers.map(publicReviewer),
    });

    stage = "opening_invite_popup";
    const invitePopup = await openInviteAllPopup(page, log);
    const popupScreenshot = await saveScreenshot(
      invitePopup,
      screenshotDir,
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
    await restoreReviewerArticleAfterInvite(page, log);

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

async function restoreReviewerArticleAfterInvite(page, log) {
  await page.bringToFront().catch(() => undefined);
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForReviewerArticle(page, 20_000);
      await log("reviewer_article_reloaded_after_invite", { attempt, url: page.url() });
      return;
    } catch (error) {
      lastError = error;
      if (!/ERR_ABORTED|frame was detached|execution context|navigation|Target page/i.test(error.message || "")) {
        throw error;
      }
      await log("reviewer_article_reload_retry", { attempt, message: error.message, url: page.url() });
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      try {
        await waitForReviewerArticle(page, 8_000);
        await log("reviewer_article_ready_after_aborted_reload", { attempt, url: page.url() });
        return;
      } catch {
        await page.waitForTimeout(400).catch(() => undefined);
      }
    }
  }
  throw lastError;
}

function isQueueExhaustedError(error) {
  return /Nie znaleziono linku (Select|Invite) Reviewers|Kolejka nie zawiera pozycji Select|Brak artykułów zarówno/i
    .test(error?.message || "");
}

function isTargetManuscriptMissingError(error) {
  return /Nie znaleziono manuskryptu .+ w kolejce (Select|Invite) Reviewers/i
    .test(error?.message || "");
}

export function reviewerQueueLabels(mode) {
  if (mode === "combined") return ["Invite Reviewers", "Select Reviewers"];
  if (mode === "invite") return ["Invite Reviewers"];
  if (mode === "select") return ["Select Reviewers"];
  throw new Error(`Nieznany tryb kolejki reviewerów: ${mode}`);
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
    startUrl: args["start-url"] || env.START_URL || "https://mc.manuscriptcentral.com/kes",
    reviewersPerPaper: positiveInteger(
      args["reviewers-per-paper"] || env.REVIEWERS_PER_PAPER,
      10,
      "--reviewers-per-paper"
    ),
    maxManuscripts: positiveInteger(args["max-manuscripts"], 1, "--max-manuscripts"),
    inviteAll: parseBool(args["invite-all"], false),
    reviewerQueueMode,
    resumeInviteReviewers: reviewerQueueMode === "invite",
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

async function createBrowserSession(config) {
  if (config.cdp) {
    const browser = await chromium.connectOverCDP(config.cdp, {
      noDefaults: true,
      slowMo: config.slowMo,
    });
    const context = browser.contexts()[0];
    if (!context) throw new Error(`Brak kontekstu Chrome pod ${config.cdp}`);
    const page = context.pages().find((candidate) => /manuscriptcentral\.com/i.test(candidate.url())) ||
      context.pages()[0] || await context.newPage();
    return {
      page,
      close: () => browser.close().catch(() => undefined),
    };
  }

  const context = await chromium.launchPersistentContext(config.profileDir, {
    channel: config.browserChannel || undefined,
    headless: config.headless,
    slowMo: config.slowMo,
    viewport: { width: 1440, height: 1000 },
  });
  return {
    page: context.pages()[0] || await context.newPage(),
    close: () => context.close(),
  };
}

async function ensureLoggedIn(page, config, log) {
  if (!(await isLoginPage(page))) {
    await log("login_not_required", { url: page.url() });
    return;
  }

  if (config.autoLogin && config.username && config.password) {
    await log("auto_login_started", { url: page.url() });
    const username = page.locator("#USERID").first();
    const password = page.locator("#PASSWORD").first();
    const login = page.locator("#logInButton").first();
    if (await username.isVisible().catch(() => false) &&
        await password.isVisible().catch(() => false) &&
        await login.isVisible().catch(() => false)) {
      await username.fill(config.username);
      await password.fill(config.password);
      const navigation = waitForNavigation(page, 15_000);
      await login.click();
      await navigation;
      if (!(await isLoginPage(page))) {
        await log("auto_login_succeeded", { url: page.url() });
        return;
      }
      const enterNavigation = waitForNavigation(page, 10_000);
      await password.press("Enter").catch(() => undefined);
      await enterNavigation;
      if (!(await isLoginPage(page))) {
        await log("auto_login_succeeded", { url: page.url(), fallback: "password_enter" });
        return;
      }
    }
    await log("auto_login_failed", { url: page.url() });
  }

  console.log("Zaloguj się ręcznie w otwartym oknie ScholarOne; automat czeka maksymalnie 5 minut.");
  await log("manual_login_wait_started", { url: page.url() });
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    const passwordVisible = Array.from(document.querySelectorAll("input[type='password']"))
      .some((element) => element.getBoundingClientRect().width > 0);
    return !passwordVisible && /log\s*out|manage|admin\s+center/i.test(text);
  }, null, { timeout: 5 * 60 * 1000 });
  await log("manual_login_succeeded", { url: page.url() });
}

async function isLoginPage(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll("input[type='password']"))
    .some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })).catch(() => false);
}

async function ensureReviewerQueue(page, log, queueLabel) {
  const queuePattern = new RegExp(`^${queueLabel.replace(/\s+/g, "\\s+")}$`, "i");
  const queueType = queueLabel.toLowerCase().replace(/\s+/g, "_");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  if (await page.locator(REVIEWER_SELECTORS.queueAction).count() > 0) {
    await log("reviewer_queue_ready", { queueLabel, queueType, source: "current_page", url: page.url() });
    return;
  }

  await log("navigate_admin_center_started", { url: page.url() });
  let adminActivated = false;
  if (await hasVisibleTextControl(page, /^admin\s+center$/i)) {
    adminActivated = await activateLinkByText(page, /^admin\s+center$/i) ||
      await clickTextControl(page, /^admin\s+center$/i);
  } else {
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
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  const queueVisible = await waitForVisibleTextControl(page, queuePattern, 12_000);
  await log("admin_center_opened", {
    url: page.url(),
    queueLabel,
    queueVisible,
  });
  if (!queueVisible && await page.locator(REVIEWER_SELECTORS.queueAction).count() === 0) {
    throw new Error("Admin Center został aktywowany, ale strona Admin Center nie załadowała się poprawnie.");
  }
  if (await page.locator(REVIEWER_SELECTORS.queueAction).count() > 0) {
    await log("reviewer_queue_ready", { queueLabel, queueType, source: "admin_center_direct", url: page.url() });
    return;
  }
  if (!(await activateLinkByText(page, queuePattern)) &&
      !(await clickTextControl(page, queuePattern))) {
    throw new Error(`Nie znaleziono linku ${queueLabel} w Admin Center.`);
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);

  await page.waitForSelector(REVIEWER_SELECTORS.queueAction, { timeout: 15_000 });
  await log("reviewer_queue_ready", {
    queueLabel,
    queueType,
    source: "admin_center",
    url: page.url(),
    items: await page.locator(REVIEWER_SELECTORS.queueAction).count(),
  });
}

async function openManageMenu(page) {
  const locators = [
    page.getByRole("link", { name: /\bmanage\b/i }).first(),
    page.getByRole("button", { name: /\bmanage\b/i }).first(),
    page.getByText(/\bManage\b/i).first(),
    page.locator("a, button, li, span, div").filter({ hasText: /\bManage\b/i }).first(),
  ];

  for (const locator of locators) {
    if ((await locator.count().catch(() => 0)) === 0) continue;
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);

    for (const action of ["hover", "click", "arrow-click"]) {
      if (action === "hover") {
        await locator.hover({ force: true, timeout: 1500 }).catch(() => undefined);
      } else if (action === "click") {
        await locator.click({ force: true, timeout: 1500 }).catch(() => undefined);
      } else {
        const box = await locator.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
          await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
        }
      }

      await page.waitForTimeout(800);
      if (await hasVisibleTextControl(page, /^admin\s+center$/i)) return true;
    }
  }

  return false;
}

async function waitForVisibleTextControl(page, pattern, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await hasVisibleTextControl(page, pattern)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function hasVisibleTextControl(page, pattern) {
  return page.evaluate((source) => {
    const regex = new RegExp(source, "i");
    return Array.from(document.querySelectorAll(
      "a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li, div, span"
    )).some((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      const text = [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      return text.length <= 160 && regex.test(text);
    });
  }, pattern.source).catch(() => false);
}

async function clickTextControl(page, pattern) {
  let clicked = false;
  try {
    clicked = await page.evaluate((source) => {
      const regex = new RegExp(source, "i");
      const candidates = Array.from(document.querySelectorAll(
        "a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li, div, span"
      )).map((element) => {
        const text = [
          element.textContent,
          element.getAttribute("value"),
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        return { element, text, rect };
      }).filter(({ text, rect }) => regex.test(text) && text.length <= 160 && rect.width > 0 && rect.height > 0)
        .sort((left, right) => left.text.length - right.text.length);
      const match = candidates[0]?.element;
      if (!match) return false;
      const control = match.closest(
        "a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li"
      ) || match;
      control.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      control.click();
      return true;
    }, pattern.source);
  } catch (error) {
    clicked = /execution context|navigation|destroyed/i.test(error.message || "");
  }
  if (clicked) await waitForNavigation(page, 12_000);
  return clicked;
}

async function activateLinkByText(page, pattern) {
  const links = page.locator("a");
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const text = (await link.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!pattern.test(text) || !(await link.isVisible().catch(() => false))) continue;
    const navigation = waitForNavigation(page, 12_000);
    await link.click({ force: true });
    await navigation;
    return true;
  }
  return false;
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

async function waitForReviewerArticle(page, timeout = 20_000) {
  await waitForReviewerListReady(page, timeout);
  await page.waitForFunction((reviewerRowSelector) => {
    const text = document.body?.innerText || "";
    return /reviewer\s+list/i.test(text) &&
      (/potential\s+reviewer\s+details/i.test(text) || document.querySelector(reviewerRowSelector));
  }, REVIEWER_SELECTORS.reviewerRow, { timeout });
}

export async function waitForReviewerListReady(page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastState = { headerText: "", bodyText: "" };

  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 1_000 }).catch(() => undefined);
    const state = await page.evaluate(() => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const heading = Array.from(document.querySelectorAll("b"))
        .find((element) => /^reviewer\s+list$/i.test(clean(element.textContent)));
      const headerText = clean(heading?.closest("tr")?.innerText || heading?.closest("tr")?.textContent);
      return {
        ready: /(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i.test(headerText),
        headerText,
        bodyText: clean(document.body?.innerText).slice(0, 160),
      };
    }).catch(() => null);

    if (state?.ready) return state;
    if (state) lastState = state;
    await page.waitForTimeout(250).catch(() => undefined);
  }

  const observed = lastState.headerText || lastState.bodyText || "(pusta strona)";
  throw new Error(`Reviewer List nie osiągnęła gotowego stanu. Ostatnia treść: ${observed}`);
}

async function readManuscriptIdentity(page) {
  const text = await page.locator("body").innerText();
  const manuscriptId = text.match(/\b([A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?)\b/i)?.[1]?.toUpperCase() || null;
  const title = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const match = body.match(/\b[A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?\b[^\n]*\n([^\n]+)/i);
    return match?.[1]?.trim() || null;
  }).catch(() => null);
  return { manuscriptId, title };
}

export async function readReviewerPage(page) {
  await waitForReviewerListReady(page);
  const raw = await evaluateAfterNavigation(page, (rowSelector) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const heading = Array.from(document.querySelectorAll("b"))
      .find((element) => /^reviewer\s+list$/i.test(clean(element.textContent)));
    const headerText = clean(heading?.closest("tr")?.innerText || heading?.closest("tr")?.textContent);
    const reviewers = Array.from(document.querySelectorAll(rowSelector)).map((input) => {
      const row = input.closest("tr");
      const cells = Array.from(row?.children || []).filter((element) => element.tagName === "TD");
      const nameCell = cells[1];
      const name = Array.from(nameCell?.querySelectorAll("a") || [])
        .map((link) => clean(link.textContent))
        .find((text) => text && !/^(proxy|grant an extension|invite again|rescind|edit reminders)$/i.test(text)) || null;
      const rowText = clean(row?.innerText || row?.textContent);
      return {
        id: input.getAttribute("value") || input.getAttribute("name"),
        name,
        email: rowText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null,
        status: clean(cells[2]?.innerText || cells[2]?.textContent),
        history: clean(cells[3]?.innerText || cells[3]?.textContent),
      };
    });
    return { headerText, reviewers };
  }, REVIEWER_SELECTORS.reviewerRow);

  const range = parseListRange(raw.headerText);
  if (!range) throw new Error(`Nie można odczytać zakresu Reviewer List z: ${raw.headerText || "(pusty nagłówek)"}`);
  if (range.empty) return { range, reviewers: [] };
  return { range, reviewers: raw.reviewers.filter(({ name }) => Boolean(name)) };
}

export async function readAllReviewerList(page, log = async () => undefined) {
  const pagination = await readPagination(page, REVIEWER_SELECTORS.reviewerPagination);
  const originalValue = pagination?.value || null;
  const values = pagination?.options.map(({ value }) => value) || [null];
  const reviewers = [];
  let reportedTotal = null;

  for (const value of values.slice(0, 50)) {
    if (value !== null && value !== (await currentPaginationValue(page, REVIEWER_SELECTORS.reviewerPagination))) {
      await navigatePagination(page, REVIEWER_SELECTORS.reviewerPagination, value);
    }
    const pageData = await readReviewerPage(page);
    reportedTotal = pageData.range.total;
    for (const reviewer of pageData.reviewers) {
      if (!reviewers.some((existing) => existing.id === reviewer.id || samePerson(existing, reviewer))) {
        reviewers.push(reviewer);
      }
    }
    await log("reviewer_list_page_read", {
      pageValue: value,
      range: pageData.range,
      rows: pageData.reviewers.length,
    });
  }

  if (originalValue && originalValue !== (await currentPaginationValue(page, REVIEWER_SELECTORS.reviewerPagination))) {
    await navigatePagination(page, REVIEWER_SELECTORS.reviewerPagination, originalValue);
  }
  if (reportedTotal !== null && reviewers.length < reportedTotal) {
    throw new Error(`Reviewer List zgłasza ${reportedTotal} osób, ale odczytano tylko ${reviewers.length}.`);
  }
  return reviewers;
}

export async function readCandidatePage(page) {
  return evaluateAfterNavigation(page, (selector) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll(selector)).map((link) => {
      const row = link.closest("tr");
      const cells = Array.from(row?.children || []).filter((element) => element.tagName === "TD");
      const details = cells[0];
      const text = clean(details?.innerText || details?.textContent);
      const href = link.getAttribute("href") || "";
      return {
        id: href.match(/XIK_POTENTIAL_REVIEWER_ID['"=,\s]+['"]?([^'"),;\s]+)/i)?.[1] ||
          href.match(/['"](xik_[A-Za-z0-9]+)['"]\s*,\s*\$\(/)?.[1] ||
          null,
        name: clean(details?.querySelector("b")?.textContent) || null,
        email: text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null,
        href,
        popupExpected: /openCreateAccountPopupForRLResult/i.test(href),
      };
    }).filter(({ id, name }) => id && name);
  }, REVIEWER_SELECTORS.candidateAdd);
}

async function addReviewersToTarget(page, { target, initialReviewers, log }) {
  const added = [];
  const skipped = [];
  let reviewers = initialReviewers;
  let count = countReviewersTowardTarget(reviewers);

  while (count < target) {
    const candidate = await findNextEligibleCandidate(page, reviewers, [...added, ...skipped], log);
    if (!candidate) {
      const error = new Error(`Brak wystarczającej liczby unikalnych kandydatów. Osiągnięto ${count}/${target}.`);
      error.code = "REVIEWER_CANDIDATES_EXHAUSTED";
      error.count = count;
      error.target = target;
      error.added = added;
      error.skipped = skipped;
      throw error;
    }
    try {
      await addCandidate(page, candidate, log);
    } catch (error) {
      if (!isReviewerCandidateSkipped(error)) throw error;
      skipped.push(candidate);
      await log("candidate_skipped", {
        candidate: publicPerson(candidate),
        reason: error.reason,
        similarAccounts: error.similarAccounts?.map(publicPerson) || [],
        skipped: skipped.length,
      });
      continue;
    }
    reviewers = await confirmCandidateAdded(page, candidate, log);
    added.push(candidate);
    const nextCount = countReviewersTowardTarget(reviewers);
    if (nextCount <= count) {
      throw new Error(`Dodano ${candidate.name}, ale liczba aktywnych wyborów nie wzrosła (${count} → ${nextCount}).`);
    }
    count = nextCount;
    await log("selection_progress", { count, target, added: added.length, candidate: publicPerson(candidate) });
  }
  return { added, skipped, reviewers };
}

export function isReviewerCandidateShortage(error) {
  return error?.code === "REVIEWER_CANDIDATES_EXHAUSTED";
}

export function isReviewerCandidateSkipped(error) {
  return error?.code === "REVIEWER_CANDIDATE_SKIPPED";
}

async function requestReviewerSearchRefresh(page, log, manuscript) {
  const refresh = page.locator(REVIEWER_SELECTORS.refreshSearch);
  const count = await refresh.count();
  if (count === 0) {
    await log("reviewer_search_refresh_still_running", {
      manuscriptId: manuscript.manuscriptId,
      url: page.url(),
    });
    return { requested: false, reason: "refresh_still_running" };
  }
  if (count !== 1) {
    throw new Error(`Oczekiwano jednego widocznego Refresh Search, znaleziono ${count}.`);
  }
  if (!(await refresh.isVisible().catch(() => false))) {
    throw new Error(`Znaleziono Refresh Search dla ${manuscript.manuscriptId}, ale przycisk nie jest widoczny.`);
  }

  const href = await refresh.getAttribute("href");
  await log("reviewer_search_refresh_ready", {
    manuscriptId: manuscript.manuscriptId,
    hasTaskId: /XIK_CURRENT_DOCUMENT_TASK_ID/i.test(href || ""),
    url: page.url(),
  });
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  }).then(() => true).catch(() => false);
  await refresh.click();
  const navigated = await navigation;
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await log("reviewer_search_refresh_clicked", {
    manuscriptId: manuscript.manuscriptId,
    navigated,
    url: page.url(),
  });
  return { requested: true, reason: "candidate_pool_exhausted" };
}

async function findNextEligibleCandidate(page, reviewers, added, log) {
  const pagination = await readPagination(page, REVIEWER_SELECTORS.candidatePagination);
  const values = pagination?.options.map(({ value }) => value) || [null];

  for (const value of values.slice(0, 50)) {
    if (value !== null && value !== (await currentPaginationValue(page, REVIEWER_SELECTORS.candidatePagination))) {
      await navigatePagination(page, REVIEWER_SELECTORS.candidatePagination, value);
    }
    const candidates = await readCandidatePage(page);
    const selected = selectUniqueCandidates(candidates, [...reviewers, ...added], 1)[0] || null;
    await log("candidate_page_scanned", {
      pageValue: value,
      candidates: candidates.length,
      eligible: selected ? publicPerson(selected) : null,
    });
    if (selected) return selected;
  }
  return null;
}

async function addCandidate(page, candidate, log) {
  const locator = page.locator(`a[href*='${candidate.id}']`).filter({
    has: page.locator("img[src$='/add.gif']"),
  }).first();
  if (!(await locator.count())) throw new Error(`Przycisk Add zniknął dla ${candidate.name}.`);

  await log("candidate_add_started", { candidate: publicPerson(candidate), popupExpected: candidate.popupExpected });
  if (candidate.popupExpected) {
    const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
    await locator.click();
    const popup = await popupPromise;
    let popupError;
    try {
      await handleCreateAccountPopup(popup, candidate, log);
    } catch (error) {
      popupError = error;
    }
    await page.bringToFront().catch(() => undefined);
    try {
      await waitForReviewerArticle(page, 15_000);
    } catch (error) {
      await log("reviewer_article_reload_after_create_account", {
        candidate: publicPerson(candidate),
        reason: error.message,
        url: page.url(),
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForReviewerArticle(page, 20_000);
    }
    if (popupError) throw popupError;
  } else {
    const navigation = waitForNavigation(page, 15_000);
    await locator.click();
    await navigation;
  }
  await log("candidate_add_action_finished", { candidate: publicPerson(candidate), url: page.url() });
}

async function handleCreateAccountPopup(popup, candidate, log) {
  await popup.waitForLoadState("domcontentloaded");
  await popup.waitForSelector(REVIEWER_SELECTORS.createAndAdd, { timeout: 15_000 });
  const popupPerson = {
    name: [
      await popup.locator("input[name='PERSON_FIRSTNAME']").inputValue().catch(() => ""),
      await popup.locator("input[name='PERSON_LASTNAME']").inputValue().catch(() => ""),
    ].filter(Boolean).join(" "),
    email: await popup.locator("input[name='EMAIL_ADDRESS']").inputValue().catch(() => ""),
  };
  if (!samePerson(candidate, popupPerson)) {
    throw new Error(`Popup Create Account nie odpowiada kandydatowi ${candidate.name}.`);
  }
  await log("create_account_popup_opened", { candidate: publicPerson(candidate), popupPerson });

  const navigation = waitForNavigation(popup, 12_000);
  await popup.locator(REVIEWER_SELECTORS.createAndAdd).first().click();
  await navigation;
  await log("create_and_add_clicked", { candidate: publicPerson(candidate), popupClosed: popup.isClosed() });

  const deadline = Date.now() + 30_000;
  let existingEmailConfirmationAttempted = false;
  while (!popup.isClosed() && Date.now() < deadline) {
    const existingEmailConflict = await readExistingEmailConflict(popup, candidate);
    if (existingEmailConflict) {
      if (!existingEmailConflict.emailMatches) {
        throw new Error(
          `ScholarOne zgłasza istniejący e-mail ${existingEmailConflict.email}, który nie odpowiada ${candidate.email}.`
        );
      }
      if (existingEmailConfirmationAttempted) {
        throw new Error(`Save and Add nie zamknął popupu istniejącego konta dla ${candidate.name}.`);
      }
      if (existingEmailConflict.controlCount !== 1 || !existingEmailConflict.controlVisible) {
        throw new Error(
          `Oczekiwano jednego widocznego Save and Add dla istniejącego konta ${candidate.name}, znaleziono ${existingEmailConflict.controlCount}.`
        );
      }

      existingEmailConfirmationAttempted = true;
      await log("existing_email_save_and_add_started", {
        candidate: publicPerson(candidate),
        email: existingEmailConflict.email,
      });
      const saveAndAdd = popup.locator(REVIEWER_SELECTORS.existingEmailSaveAndAdd);
      const completion = Promise.race([
        popup.waitForEvent("close", { timeout: 20_000 }).then(() => "closed").catch(() => null),
        popup.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 20_000,
        }).then(() => "navigated").catch(() => null),
      ]);
      await saveAndAdd.click();
      const completionType = await completion;
      await popup.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
      await log("existing_email_save_and_add_finished", {
        candidate: publicPerson(candidate),
        completionType,
        popupClosed: popup.isClosed(),
      });
      continue;
    }

    const similarAccounts = await readPopupAddOptions(popup);
    const match = findMatchingSimilarAccount(candidate, similarAccounts);
    if (match) {
      await log("similar_account_found", { candidate: publicPerson(candidate), account: publicPerson(match) });
      const add = popup.locator(`a[href*='${match.id}']`).filter({
        has: popup.locator("img[src$='/add.gif']"),
      }).first();
      const addNavigation = waitForNavigation(popup, 12_000);
      await add.click();
      await addNavigation;
      await log("similar_account_add_clicked", { account: publicPerson(match) });
      continue;
    }
    if (similarAccounts.length > 0) {
      await log("similar_accounts_no_match", {
        candidate: publicPerson(candidate),
        accounts: similarAccounts.map(publicPerson),
      });
      const closed = await popup.close().then(() => true).catch(() => popup.isClosed());
      if (!closed && !popup.isClosed()) {
        throw new Error(`Nie udało się zamknąć popupu z niedopasowanymi kontami dla ${candidate.name}.`);
      }
      const error = new Error(
        `Pomijam ${candidate.name}/${candidate.email}: ScholarOne pokazał podobne konta, ale żadne nie pasuje.`
      );
      error.code = "REVIEWER_CANDIDATE_SKIPPED";
      error.reason = "similar_accounts_no_match";
      error.similarAccounts = similarAccounts;
      throw error;
    }
    await popup.waitForTimeout(500).catch(() => undefined);
  }
  if (!popup.isClosed()) {
    throw new Error(`Popup Create Account nie zamknął się po dodaniu ${candidate.name}.`);
  }
  await log("create_account_popup_closed", { candidate: publicPerson(candidate) });
}

export function findMatchingSimilarAccount(candidate, similarAccounts) {
  const candidateEmail = String(candidate?.email || "").trim().toLowerCase();
  if (candidateEmail) {
    return similarAccounts.find((account) =>
      String(account?.email || "").trim().toLowerCase() === candidateEmail
    ) || null;
  }
  return similarAccounts.find((account) => samePerson(candidate, account)) || null;
}

export async function readExistingEmailConflict(popup, candidate) {
  if (popup.isClosed()) return null;
  const warningVisible = await popup.locator("body").innerText()
    .then((text) => /person with this e-?mail address already exists in the system/i.test(text))
    .catch(() => false);
  if (!warningVisible) return null;

  const email = await popup.locator("input[name='EMAIL_ADDRESS']").inputValue().catch(() => "");
  const candidateEmail = String(candidate?.email || "").trim().toLowerCase();
  const control = popup.locator(REVIEWER_SELECTORS.existingEmailSaveAndAdd);
  const controlCount = await control.count();
  const controlVisible = controlCount === 1 && await control.isVisible().catch(() => false);
  return {
    email,
    emailMatches: Boolean(candidateEmail) && email.trim().toLowerCase() === candidateEmail,
    controlCount,
    controlVisible,
  };
}

async function readPopupAddOptions(popup) {
  return popup.evaluate((selector) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll(selector)).map((link, index) => {
      const row = link.closest("tr");
      const text = clean(row?.innerText || row?.textContent);
      return {
        id: (link.getAttribute("href") || "").match(/xik_[A-Za-z0-9]+/)?.[0] || String(index),
        name: clean(row?.querySelector("b")?.textContent) || null,
        email: text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null,
      };
    }).filter(({ name, email }) => name || email);
  }, REVIEWER_SELECTORS.candidateAdd).catch(() => []);
}

async function confirmCandidateAdded(page, candidate, log) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const reviewers = await readAllReviewerList(page, log);
    const match = reviewers.find((reviewer) => samePerson(candidate, reviewer));
    if (match) {
      await log("candidate_confirmed_in_reviewer_list", {
        attempt,
        candidate: publicPerson(candidate),
        reviewer: publicReviewer(match),
      });
      return reviewers;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${candidate.name} nie pojawił się w Reviewer List po Add.`);
}

async function openInviteAllPopup(page, log) {
  const locator = page.locator(REVIEWER_SELECTORS.firstInviteAll);
  const locatorCount = await locator.count();
  if (locatorCount !== 1) {
    throw new Error(`Oczekiwano jednego widocznego pierwszego Invite All, znaleziono ${locatorCount}.`);
  }
  await locator.waitFor({ state: "visible" });
  const href = await locator.getAttribute("href");
  const popupTarget = extractPopWindowTarget(href);
  const context = page.context();
  const existingNamedPopup = await findNamedPage(context, "invite_all_popup", page);
  await log("first_invite_all_ready", {
    url: page.url(),
    hasPopupTarget: Boolean(popupTarget),
    reusingNamedPopup: Boolean(existingNamedPopup),
  });

  const popupPromise = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
  const contextPagePromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
  await locator.click();
  await log("first_invite_all_clicked", { url: page.url() });

  let popup = existingNamedPopup || await Promise.race([popupPromise, contextPagePromise]);
  let openMethod = existingNamedPopup ? "reused_named_window" : "popup_event";

  if (!popup) {
    popup = await findNamedPage(context, "invite_all_popup", page);
    if (popup) openMethod = "named_window_after_click";
  }

  if (!popup && popupTarget) {
    popup = await context.newPage();
    const targetUrl = new URL(popupTarget, page.url()).href;
    await log("invite_all_popup_event_missing", {
      note: "Kliknięcie nie zgłosiło nowego popupu; otwieram ten sam pierwszy etap z adresu popWindow.",
    });
    await popup.goto(targetUrl, { waitUntil: "domcontentloaded" });
    openMethod = "popwindow_url_fallback";
  }

  if (!popup) {
    throw new Error("Kliknięto pierwszy Invite All, ale ScholarOne nie otworzył popupu i nie udało się odczytać adresu z popWindow(...).");
  }

  await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
  await popup.waitForSelector(REVIEWER_SELECTORS.finalInviteAll, { timeout: 15_000 });
  await popup.bringToFront().catch(() => undefined);
  await log("invite_all_popup_opened", { url: popup.url(), openMethod });
  return popup;
}

export function extractPopWindowTarget(href) {
  if (typeof href !== "string") return null;
  const match = href.match(/popWindow\(\s*(['"])(.*?)\1\s*,/i);
  return match?.[2]
    ?.replace(/\\x3f/gi, "?")
    .replace(/\\x26/gi, "&")
    .replace(/&amp;/gi, "&") || null;
}

async function findNamedPage(context, expectedName, excludedPage) {
  for (const candidate of context.pages()) {
    if (candidate === excludedPage || candidate.isClosed()) continue;
    const name = await candidate.evaluate(() => window.name).catch(() => "");
    if (name === expectedName) return candidate;
  }
  return null;
}

async function clickFinalInviteAll(popup, log) {
  const dialogMessages = [];
  const dialogHandler = async (dialog) => {
    const dialogType = dialog.type();
    const message = dialog.message();
    await dialog.accept();
    dialogMessages.push(message);
    await log("final_invite_all_dialog_accepted", { dialogType, message });
  };
  popup.on("dialog", dialogHandler);
  try {
    const locator = popup.locator(REVIEWER_SELECTORS.finalInviteAll);
    const locatorCount = await locator.count();
    if (locatorCount !== 1) {
      throw new Error(`Oczekiwano jednego widocznego finalnego Invite All, znaleziono ${locatorCount}.`);
    }
    await log("final_invite_all_click_started", { url: popup.url() });
    const closed = popup.waitForEvent("close", { timeout: 30_000 }).then(() => true).catch(() => false);
    const navigation = waitForNavigation(popup, 30_000);
    await locator.click();
    const [popupClosed] = await Promise.all([closed, navigation]);
    await log("final_invite_all_click_finished", { popupClosed, dialogMessages });
    return { clicked: true, popupClosed, dialogMessages };
  } finally {
    if (!popup.isClosed()) popup.off("dialog", dialogHandler);
  }
}

export function reviewersPendingInvitation(reviewers) {
  return reviewers.filter((reviewer) => classifyReviewerStatus(reviewer).status === "selected");
}

export function confirmInvitationsSent({ beforeCounters, afterCounters, afterReviewers, expected }) {
  const invitedIncrease = (afterCounters?.invited || 0) - (beforeCounters?.invited || 0);
  const expectedStatuses = expected.map((person) => {
    const reviewer = afterReviewers.find((item) => samePerson(person, item));
    const classification = reviewer ? classifyReviewerStatus(reviewer) : null;
    return {
      person: publicPerson(person),
      found: Boolean(reviewer),
      status: classification?.status || null,
      overdue: classification?.overdue || false,
    };
  });
  const confirmedExpected = expectedStatuses.filter(({ status }) => status === "invited").length;
  const confirmed = expected.length > 0
    ? confirmedExpected === expected.length || invitedIncrease >= expected.length
    : invitedIncrease > 0;
  return {
    confirmed,
    invitedIncrease,
    beforeCounters,
    afterCounters,
    confirmedExpected,
    expectedCount: expected.length,
    expectedStatuses,
  };
}

async function readArticleCounters(page) {
  const text = await page.locator("body").innerText();
  const match = text.match(/(\d+)\s+active\s+selections?;\s*(\d+)\s+invited;\s*(\d+)\s+agreed;\s*(\d+)\s+declined;\s*(\d+)\s+returned/i);
  return match ? {
    activeSelections: Number(match[1]),
    invited: Number(match[2]),
    agreed: Number(match[3]),
    declined: Number(match[4]),
    returned: Number(match[5]),
  } : null;
}

async function readPagination(page, selector) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) return null;
  return evaluateAfterNavigation(page, (paginationSelector) => {
    const select = document.querySelector(paginationSelector);
    if (!select) return null;
    return {
      value: select.value,
      options: Array.from(select.options).map((option) => ({
        value: option.value,
        text: (option.textContent || "").replace(/\s+/g, " ").trim(),
      })),
    };
  }, selector);
}

async function currentPaginationValue(page, selector) {
  return page.locator(selector).first().inputValue().catch(() => null);
}

async function navigatePagination(page, selector, value) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) throw new Error(`Zniknęła kontrolka paginacji ${selector}.`);
  // ScholarOne submits the entire form here. With slowMo the navigation can
  // start more than three seconds after selectOption, so the general-purpose
  // short navigation helper is not sufficient for pagination.
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  }).then(() => true).catch(() => false);
  await locator.selectOption(String(value));
  const navigated = await navigation;
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForFunction(
    ({ paginationSelector, expectedValue }) =>
      document.querySelector(paginationSelector)?.value === expectedValue,
    { paginationSelector: selector, expectedValue: String(value) },
    { timeout: navigated ? 5_000 : 10_000 }
  );
}

async function evaluateAfterNavigation(page, pageFunction, argument) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.evaluate(pageFunction, argument);
    } catch (error) {
      lastError = error;
      if (!/execution context was destroyed|cannot find context|navigat/i.test(error?.message || "")) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(250).catch(() => undefined);
    }
  }
  throw lastError;
}

async function waitForNavigation(page, timeout) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).catch(() => undefined),
    page.waitForTimeout(Math.min(timeout, 3000)).catch(() => undefined),
  ]);
}

function summarizeReviewerList(reviewers, countTowardTarget) {
  return {
    total: reviewers.length,
    countTowardTarget,
    reviewers: reviewers.map(publicReviewer),
  };
}

function publicReviewer(reviewer) {
  const classification = classifyReviewerStatus(reviewer);
  return {
    name: reviewer.name,
    email: reviewer.email || null,
    status: reviewer.status,
    history: reviewer.history,
    classification: classification.status,
    overdue: classification.overdue,
  };
}

function publicPerson(person) {
  return { name: person.name, email: person.email || null };
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

function createLogger(logFile) {
  return async (type, payload = {}) => {
    const entry = { type, at: new Date().toISOString(), ...payload };
    await fsp.mkdir(path.dirname(logFile), { recursive: true });
    await fsp.appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
    console.log(`[select-reviewers] ${type} ${JSON.stringify(payload)}`);
  };
}

async function saveScreenshot(page, directory, name) {
  const target = path.join(directory, `${name.replace(/[^a-z0-9-]+/gi, "-")}.png`);
  if (!page || page.isClosed()) return null;
  await page.screenshot({ path: target, fullPage: true }).catch(() => undefined);
  return target;
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (const arg of rawArgs) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const index = body.indexOf("=");
    if (index === -1) parsed[body] = true;
    else parsed[body.slice(0, index)] = body.slice(index + 1);
  }
  return parsed;
}

function loadEnvFile(filePath) {
  try {
    return Object.fromEntries(fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return index === -1 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
      }));
  } catch {
    return {};
  }
}

function loadLoginCredentials(args, env) {
  let username = args["login-username"] || env.LOGIN_USERNAME || "";
  let password = args["login-password"] || env.LOGIN_PASSWORD || "";
  const credentialsFile = args["login-credentials-file"] || env.LOGIN_CREDENTIALS_FILE || "";
  if (credentialsFile && (!username || !password)) {
    const absolute = path.isAbsolute(credentialsFile) ? credentialsFile : path.join(projectRoot, credentialsFile);
    const content = fs.readFileSync(absolute, "utf8");
    if (/^\s*[A-Z0-9_]+\s*=/im.test(content)) {
      const fileEnv = loadEnvFile(absolute);
      username ||= fileEnv.LOGIN_USERNAME || fileEnv.USERNAME || "";
      password ||= fileEnv.LOGIN_PASSWORD || fileEnv.PASSWORD || "";
    } else {
      const lines = content.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      username ||= lines[0] || "";
      password ||= lines[1] || "";
    }
  }
  return { username, password };
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!/^\d+$/.test(String(value).trim())) throw new Error(`${label} musi być dodatnią liczbą całkowitą.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} musi być dodatnią liczbą całkowitą.`);
  return parsed;
}

function nonNegativeInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!/^\d+$/.test(String(value).trim())) throw new Error(`${label} musi być nieujemną liczbą całkowitą.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} musi być nieujemną liczbą całkowitą.`);
  return parsed;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

async function waitUntilInterrupted() {
  await new Promise((resolve) => {
    const interval = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(interval);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
