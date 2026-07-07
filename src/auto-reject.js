import { chromium } from "playwright";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REJECT_MESSAGE } from "./default-message.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const DEFAULTS = {
  startUrl: "https://mc.manuscriptcentral.com/kes",
  maxChecked: 10,
  submittedOlderThanDays: 30,
  headless: false,
  profileDir: path.join(projectRoot, "playwright-profile"),
  logsDir: path.join(projectRoot, "logs"),
};

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
  autoLogin: parseBool(args["auto-login"] ?? env.AUTO_LOGIN, Boolean(loginCredentials.username && loginCredentials.password)),
  loginUsername: loginCredentials.username,
  loginPassword: loginCredentials.password,
  queueStartPage: toInteger(args["queue-start-page"] || env.QUEUE_START_PAGE, 0),
  rejectFromReport: args["reject-from-report"] || env.REJECT_FROM_REPORT || "",
  rejectIds: parseIdList(args["reject-ids"] || env.REJECT_IDS || ""),
  rejectProgressFile: args["reject-progress-file"] || env.REJECT_PROGRESS_FILE || "",
  requireTargets: parseBool(args["require-targets"] ?? env.REQUIRE_TARGETS, false),
  rejectMessage: loadRejectMessage(args, env),
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

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(config.logsDir, `${runId}.jsonl`);
const screenshotDir = path.join(config.logsDir, "screenshots", runId);
const reportDir = path.join(config.logsDir, "reports");

await fsp.mkdir(screenshotDir, { recursive: true });
await fsp.mkdir(reportDir, { recursive: true });

const browserSession = await createBrowserSession();
const { page } = browserSession;
page.setDefaultTimeout(15000);

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
  });

  if (config.requireTargets && !config.rejectFromReport && config.rejectIds.length === 0) {
    throw new Error("Ten tryb wymaga --reject-from-report=... albo --reject-ids=...");
  }

  if (!config.cdp || page.url() === "about:blank") {
    await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
  }
  await ensureLoggedIn(page, { reason: "startup" });

  const result = config.rejectFromReport || config.rejectIds.length
    ? await runRejectTargetsFromSearch(page)
    : await runScan(page);
  result.summary = buildRunSummary(result);
  result.artifacts = await writeRunArtifacts(result);

  await logEvent("run_finished", result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const screenshot = await saveScreenshot(page, "error");
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

async function createBrowserSession() {
  if (config.cdp) {
    const browser = await chromium.connectOverCDP(config.cdp, {
      noDefaults: true,
      slowMo: config.slowMo,
    });
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error(`Nie udalo sie znalezc kontekstu Chrome pod ${config.cdp}`);
    }

    const existingPage =
      context.pages().find((candidate) => /manuscriptcentral\.com/i.test(candidate.url())) ||
      context.pages().find((candidate) => candidate.url() !== "about:blank") ||
      context.pages()[0] ||
      await context.newPage();

    return {
      page: existingPage,
      close: async () => {
        await browser.close().catch(() => undefined);
      },
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
    close: async () => {
      await context.close();
    },
  };
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
        const screenshot = await saveScreenshot(page, "queue-ready");
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
      const screenshot = await saveScreenshot(page, `needs-review-${checked}`);
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
      const screenshot = await saveScreenshot(page, `candidate-before-reject-${checked}`);

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
      const screenshot = await saveScreenshot(emailPage || page, `candidate-reject-step-failed-${checked}`);

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
      const screenshot = await saveScreenshot(emailPage || page, `candidate-email-filled-${checked}`);

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
      const screenshot = await saveScreenshot(emailPage || page, `candidate-max-rejected-reached-${checked}`);

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
      const screenshot = await saveScreenshot(sendResult.emailPageClosed ? page : emailPage || page, `candidate-save-send-failed-${checked}`);

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
    const screenshot = await saveScreenshot(page, `candidate-sent-${checked}`);

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
      const screenshot = await saveScreenshot(page, `search-not-actionable-no-reject-${checked}`);
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
      const screenshot = await saveScreenshot(page, `search-candidate-before-reject-${checked}`);
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
      const screenshot = await saveScreenshot(emailPage || page, `search-reject-step-failed-${checked}`);
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
      const screenshot = await saveScreenshot(emailPage || page, `search-email-filled-${checked}`);
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
      const screenshot = await saveScreenshot(sendResult.emailPageClosed ? page : emailPage || page, `search-save-send-failed-${checked}`);
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

async function ensureHeaderSearchReady(page) {
  const input = page.locator("#QUICK_SEARCH_HEADER_SEARCH_TEXT").first();
  if (await input.isVisible({ timeout: 1500 }).catch(() => false)) {
    return true;
  }

  const toggle = page.locator("#headerSearchbar").first();
  if (await toggle.isVisible({ timeout: 1500 }).catch(() => false)) {
    await toggle.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }

  if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
    return true;
  }

  const toggled = await page.evaluate(() => {
    const input = document.querySelector("#QUICK_SEARCH_HEADER_SEARCH_TEXT");
    const toggle = document.querySelector("#headerSearchbar");
    if (!input && !toggle) {
      return false;
    }

    if (toggle) {
      toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      toggle.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      toggle.click();
    }

    return Boolean(document.querySelector("#QUICK_SEARCH_HEADER_SEARCH_TEXT"));
  }).catch(() => false);

  return toggled && await input.isVisible({ timeout: 3000 }).catch(() => false);
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

async function isLoginPage(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    if (/log\s*out|admin\s+center|complete\s+checklist|view\s+details|manuscripts\s+\d+\s*-\s*\d+\s+of/i.test(text)) {
      return false;
    }

    const passwordInput = Array.from(document.querySelectorAll("input[type='password']")).some(isVisible);
    if (passwordInput) {
      return true;
    }

    const usernameInput = Array.from(document.querySelectorAll("input")).some((input) => {
      const label = [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute("aria-label"),
      ]
        .filter(Boolean)
        .join(" ");
      return isVisible(input) && /user\s*name|username|user\s*id|email|login/i.test(label);
    });

    const loginControl = Array.from(
      document.querySelectorAll("button, input[type='button'], input[type='submit'], input[type='image'], a")
    ).some((element) => {
      const label = [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
      ]
        .filter(Boolean)
        .join(" ");
      return isVisible(element) && /log\s*in|sign\s*in/i.test(label);
    });

    return usernameInput && loginControl;

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }).catch(() => false);
}

async function ensureLoggedIn(page, { reason = "unknown" } = {}) {
  if (!(await isLoginPage(page))) {
    return false;
  }

  if (config.autoLogin && config.loginUsername && config.loginPassword) {
    console.log("Wyglada na to, ze sesja wygasla. Probuje zalogowac automatycznie...");
    await logEvent("auto_login_started", { reason, url: page.url() });

    const autoLoginResult = await performAutoLogin(page, {
      username: config.loginUsername,
      password: config.loginPassword,
    });

    await logEvent("auto_login_attempted", {
      reason,
      ...autoLoginResult,
    });

    if (autoLoginResult.loginMarkersFound || !(await isLoginPage(page))) {
      console.log("Auto-login OK, kontynuuje.");
      await logEvent("auto_login_succeeded", { reason, url: page.url() });
      return true;
    }

    const screenshot = await saveScreenshot(page, `auto-login-failed-${reason}`);
    await logEvent("auto_login_failed", {
      reason,
      url: page.url(),
      screenshot,
    });
    console.log(`Auto-login nie przeszedl. Screenshot: ${screenshot}`);
    console.log("Zaloguj sie recznie w otwartym oknie; skrypt poczeka.");
  } else {
    console.log(
      "Wyglada na to, ze trzeba sie zalogowac. Zaloguj sie recznie w otwartym oknie; skrypt poczeka."
    );
  }

  await waitForManualLogin(page);
  return true;
}

async function waitForManualLogin(page) {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    if (/view\s+details|log\s*out|manage|admin\s+center/i.test(text)) {
      return true;
    }

    const controls = Array.from(
      document.querySelectorAll("select option, a, button, input[type='button'], input[type='submit'], input[type='image']")
    );
    return controls.some((element) => {
      const label = [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
      ]
        .filter(Boolean)
        .join(" ");
      return /view\s+details/i.test(label);
    });
  }, null, { timeout: 5 * 60 * 1000 });
}

async function performAutoLogin(page, credentials) {
  const scholarOneResult = await performScholarOneAutoLogin(page, credentials);
  if (scholarOneResult.usedKnownSelectors) {
    return scholarOneResult;
  }

  const result = await page.evaluate(({ username, password }) => {
    const passwordInput = Array.from(document.querySelectorAll("input[type='password']")).find(isVisible);
    if (!passwordInput) {
      return {
        filledUsername: false,
        filledPassword: false,
        clickedLogin: false,
        note: "No visible password input found.",
      };
    }

    const usernameInput = findUsernameInput(passwordInput);
    if (!usernameInput) {
      return {
        filledUsername: false,
        filledPassword: false,
        clickedLogin: false,
        note: "No visible username input found.",
      };
    }

    setInputValue(usernameInput, username);
    setInputValue(passwordInput, password);

    const loginControl = findLoginControl(passwordInput.form);
    if (loginControl) {
      loginControl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      loginControl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      loginControl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      loginControl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      loginControl.click();
    } else if (passwordInput.form) {
      HTMLFormElement.prototype.submit.call(passwordInput.form);
    }

    return {
      filledUsername: true,
      filledPassword: true,
      clickedLogin: Boolean(loginControl),
      submittedFormDirectly: !loginControl && Boolean(passwordInput.form),
      loginControlLabel: loginControl ? elementLabel(loginControl).slice(0, 120) : null,
      usernameInputName: usernameInput.name || usernameInput.id || null,
      passwordInputName: passwordInput.name || passwordInput.id || null,
      loginControlTag: loginControl ? loginControl.tagName : null,
    };

    function findUsernameInput(referencePasswordInput) {
      const inputs = Array.from(document.querySelectorAll("input"))
        .filter((input) => isVisible(input) && !/^(hidden|password|submit|button|checkbox|radio)$/i.test(input.type || ""));

      const labeled = inputs.find((input) =>
        /user\s*name|username|user\s*id|email|login/i.test([
          input.name,
          input.id,
          input.placeholder,
          input.getAttribute("aria-label"),
          input.getAttribute("title"),
        ].filter(Boolean).join(" "))
      );
      if (labeled) {
        return labeled;
      }

      const beforePassword = inputs.filter((input) => input.compareDocumentPosition(referencePasswordInput) & Node.DOCUMENT_POSITION_FOLLOWING);
      return beforePassword.at(-1) || inputs[0] || null;
    }

    function findLoginControl(form) {
      const controls = Array.from(
        document.querySelectorAll("button, input[type='button'], input[type='submit'], input[type='image'], a")
      ).filter(isVisible);

      const labeled = controls.find((control) => /log\s*in|sign\s*in|submit|continue/i.test(elementLabel(control)));
      if (labeled) {
        return labeled;
      }

      if (form) {
        return Array.from(form.querySelectorAll("button, input[type='button'], input[type='submit'], input[type='image']")).find(isVisible) || null;
      }

      return null;
    }

    function setInputValue(input, value) {
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function elementLabel(element) {
      return [
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
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }, credentials).catch((error) => ({
    filledUsername: false,
    filledPassword: false,
    clickedLogin: false,
    note: error.message,
  }));

  let pressedEnterFallback = false;
  let loggedIn = await waitForLoggedInAfterAutoLogin(page, 12000);
  if (!loggedIn && result.filledPassword) {
    pressedEnterFallback = true;
    await page.keyboard.press("Enter").catch(() => undefined);
    loggedIn = await waitForLoggedInAfterAutoLogin(page, 10000);
  }
  const stillOnLoginPage = !loggedIn && await isLoginPage(page);

  return {
    ...result,
    pressedEnterFallback,
    loginMarkersFound: loggedIn,
    stillOnLoginPage,
    loginFailureText: stillOnLoginPage ? await readLoginFailureText(page) : null,
  };
}

async function performScholarOneAutoLogin(page, credentials) {
  const usernameInput = page.locator("#USERID").first();
  const passwordInput = page.locator("#PASSWORD").first();
  const loginButton = page.locator("#logInButton").first();

  const [hasUsername, hasPassword, hasLoginButton] = await Promise.all([
    usernameInput.isVisible({ timeout: 1500 }).catch(() => false),
    passwordInput.isVisible({ timeout: 1500 }).catch(() => false),
    loginButton.isVisible({ timeout: 1500 }).catch(() => false),
  ]);

  if (!hasUsername || !hasPassword || !hasLoginButton) {
    return { usedKnownSelectors: false };
  }

  let clickedLogin = false;
  let pressedEnterFallback = false;
  let note = null;

  try {
    await usernameInput.click({ timeout: 5000 });
    await usernameInput.fill(credentials.username);
    await passwordInput.click({ timeout: 5000 });
    await passwordInput.fill(credentials.password);

    try {
      await loginButton.click({ timeout: 5000 });
      clickedLogin = true;
    } catch (error) {
      note = `Playwright click failed, used DOM click fallback: ${error.message}`;
      clickedLogin = await page.evaluate(() => {
        const button = document.querySelector("#logInButton");
        if (!button) {
          return false;
        }

        button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        button.click();
        return true;
      });
    }

    let loggedIn = await waitForLoggedInAfterAutoLogin(page, 12000);
    if (!loggedIn) {
      pressedEnterFallback = true;
      await passwordInput.press("Enter").catch(() => page.keyboard.press("Enter").catch(() => undefined));
      loggedIn = await waitForLoggedInAfterAutoLogin(page, 10000);
    }

    const stillOnLoginPage = !loggedIn && await isLoginPage(page);

    return {
      usedKnownSelectors: true,
      filledUsername: true,
      filledPassword: true,
      clickedLogin,
      submittedFormDirectly: false,
      loginControlLabel: "Log In",
      usernameInputName: "USERID",
      passwordInputName: "PASSWORD",
      loginControlTag: "A",
      pressedEnterFallback,
      loginMarkersFound: loggedIn,
      stillOnLoginPage,
      loginFailureText: stillOnLoginPage ? await readLoginFailureText(page) : null,
      note,
    };
  } catch (error) {
    const stillOnLoginPage = await isLoginPage(page);
    return {
      usedKnownSelectors: true,
      filledUsername: false,
      filledPassword: false,
      clickedLogin,
      submittedFormDirectly: false,
      loginControlLabel: "Log In",
      usernameInputName: "USERID",
      passwordInputName: "PASSWORD",
      loginControlTag: "A",
      pressedEnterFallback,
      loginMarkersFound: false,
      stillOnLoginPage,
      loginFailureText: stillOnLoginPage ? await readLoginFailureText(page) : null,
      note: error.message,
    };
  }
}

async function readLoginFailureText(page) {
  return page.evaluate(() => {
    const selectors = [
      ".alert",
      ".alert-error",
      ".error",
      ".errors",
      ".text-error",
      "#error",
      "[role='alert']",
      ".help-inline",
    ];

    const candidates = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter(isVisible)
      .map((element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const failure = candidates.find((text) =>
      /invalid|incorrect|required|try\s+again|captcha|locked|expired|failed|error|not\s+recognized|nieprawid|wymagan/i.test(text)
    );

    return failure ? failure.slice(0, 300) : null;

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }).catch(() => null);
}

async function waitForLoggedInAfterAutoLogin(page, timeout = 20000) {
  const loggedIn = await page.waitForFunction(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    const hasLoggedInMarker =
      /log\s*out|admin\s+center|complete\s+checklist|view\s+details|manuscripts\s+\d+\s*-\s*\d+\s+of/i.test(text);
    const hasQueueSelect = Boolean(
      document.querySelector("select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']")
    );
    const hasVisiblePasswordInput = Array.from(document.querySelectorAll("input[type='password']")).some(isVisible);

    return (hasLoggedInMarker || hasQueueSelect) && !hasVisiblePasswordInput;

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }, null, { timeout }).then(() => true).catch(() => false);

  if (loggedIn) {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  }

  return loggedIn;
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

async function openManageMenu(page) {
  const locators = [
    page.getByRole("link", { name: /\bmanage\b/i }).first(),
    page.getByRole("button", { name: /\bmanage\b/i }).first(),
    page.getByText(/\bManage\b/i).first(),
    page.locator("a, button, li, span, div").filter({ hasText: /\bManage\b/i }).first(),
  ];

  for (const locator of locators) {
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }

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
      if (await hasVisibleTextControl(page, /admin\s+center/i)) {
        return true;
      }
    }
  }

  const hovered = await hoverTextControl(page, /\bmanage\b/i);
  if (hovered) {
    await page.waitForTimeout(800);
    if (await hasVisibleTextControl(page, /admin\s+center/i)) {
      return true;
    }
  }

  const clicked = await clickTextControl(page, /\bmanage\b/i);
  if (clicked) {
    await page.waitForTimeout(800);
    if (await hasVisibleTextControl(page, /admin\s+center/i)) {
      return true;
    }
  }

  return false;
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
  const maxQueuePageHops = Math.max(3, Math.ceil(config.maxChecked / 10) + 5);

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

async function waitForNavigationOrTimeout(page, timeout = 8000) {
  await Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).catch(() => undefined),
    page.waitForTimeout(timeout),
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
  const manuscriptId = extractManuscriptId(bodyText);
  const submittedDate = extractSubmittedDate(bodyText);
  const hasUnusualActivity = /high\s+rate\s+of\s+unusual\s+activity/i.test(bodyText);
  const isRevision = manuscriptId ? /\.R\d+$/i.test(manuscriptId) : false;

  if (!manuscriptId) {
    return {
      action: "manual_review",
      reason: "Nie udalo sie odczytac Manuscript ID.",
      manuscriptId: null,
      submittedDate: submittedDate ? submittedDate.toISOString() : null,
      hasUnusualActivity,
      isRevision,
    };
  }

  if (isRevision) {
    return {
      action: "skip",
      reason: "Manuscript ID jest rewizja (.R + liczba).",
      manuscriptId,
      submittedDate: submittedDate ? submittedDate.toISOString() : null,
      hasUnusualActivity,
      isRevision,
    };
  }

  const submittedMoreThanLimit =
    submittedDate &&
    daysBetweenUtcMidnights(submittedDate, new Date()) > config.submittedOlderThanDays;

  if (hasUnusualActivity || submittedMoreThanLimit) {
    const reasons = [];
    if (hasUnusualActivity) {
      reasons.push("ma komunikat High rate of unusual activity");
    }
    if (submittedMoreThanLimit) {
      reasons.push(`Date submitted jest starsze niz ${config.submittedOlderThanDays} dni`);
    }

    return {
      action: "candidate",
      reason: reasons.join("; "),
      manuscriptId,
      submittedDate: submittedDate ? submittedDate.toISOString() : null,
      hasUnusualActivity,
      isRevision,
      submittedMoreThanLimit,
    };
  }

  return {
    action: "skip",
    reason: "Brak rewizji .R + liczba, ale nie ma unusual activity ani daty starszej niz limit.",
    manuscriptId,
    submittedDate: submittedDate ? submittedDate.toISOString() : null,
    hasUnusualActivity,
    isRevision,
    submittedMoreThanLimit,
  };
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

async function clickRejectAndFillEmail(page) {
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

  const emailResult = await fillRejectEmailBody(emailPage, config.rejectMessage);

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

async function clickControlByText(page, pattern) {
  return page.evaluate((source) => {
    const regex = new RegExp(source, "i");
    const elements = Array.from(
      document.querySelectorAll(
        "a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li, div, span"
      )
    );
    const candidates = elements
      .map((element) => {
        const text = elementLabel(element);
        const rect = element.getBoundingClientRect();
        return { element, text, rect };
      })
      .filter(({ text, rect }) =>
        regex.test(text) &&
        text.length <= 160 &&
        rect.width > 0 &&
        rect.height > 0
      )
      .sort((a, b) => a.text.length - b.text.length);

    const match = candidates[0]?.element;

    if (!match) {
      return false;
    }

    const clickable =
      match.closest("a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li") ||
      match;

    clickable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    clickable.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    clickable.click();
    return true;

    function elementLabel(element) {
      return [
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
    }
  }, pattern.source);
}

async function clickTextControl(page, pattern) {
  return clickControlByText(page, pattern);
}

async function hoverTextControl(page, pattern) {
  return page.evaluate((source) => {
    const regex = new RegExp(source, "i");
    const elements = Array.from(
      document.querySelectorAll(
        "a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li, div, span"
      )
    );
    const candidates = elements
      .map((element) => {
        const text = elementLabel(element);
        const rect = element.getBoundingClientRect();
        return { element, text, rect };
      })
      .filter(({ text, rect }) =>
        regex.test(text) &&
        text.length <= 160 &&
        rect.width > 0 &&
        rect.height > 0
      )
      .sort((a, b) => a.text.length - b.text.length);

    const match = candidates[0]?.element;

    if (!match) {
      return false;
    }

    const hoverable =
      match.closest("a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li") ||
      match;

    hoverable.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    hoverable.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    return true;

    function elementLabel(element) {
      return [
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
    }
  }, pattern.source);
}

async function hasPageText(page, pattern) {
  const text = await page.locator("body").innerText().catch(() => "");
  return pattern.test(text);
}

async function hasVisibleTextControl(page, pattern) {
  return page.evaluate((source) => {
    const regex = new RegExp(source, "i");
    const elements = Array.from(
      document.querySelectorAll(
        "a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li, div, span"
      )
    );

    return elements.some((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }

      const text = [
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

      return text.length <= 160 && regex.test(text);
    });
  }, pattern.source).catch(() => false);
}

async function findHrefByText(page, pattern) {
  return page.evaluate((source) => {
    const regex = new RegExp(source, "i");
    const links = Array.from(document.querySelectorAll("a[href]"));
    const match = links.find((link) => {
      const labels = [
        link.textContent,
        link.getAttribute("title"),
        link.getAttribute("aria-label"),
      ]
        .filter(Boolean)
        .map((value) => value.replace(/\s+/g, " ").trim());

      return labels.some((text) => regex.test(text));
    });

    if (!match) {
      return null;
    }

    const href = match.getAttribute("href");
    if (!href || /^javascript:/i.test(href) || href === "#") {
      return null;
    }

    return new URL(href, window.location.href).href;
  }, pattern.source).catch(() => null);
}

async function activateLinkByText(page, pattern) {
  const navigation = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12000 })
    .then(() => true)
    .catch(() => false);

  let activated = false;
  try {
    activated = await page.evaluate((source) => {
      const regex = new RegExp(source, "i");
      const links = Array.from(document.querySelectorAll("a"));
      const candidates = links
        .map((link) => {
          const labels = [
            link.textContent,
            link.getAttribute("title"),
            link.getAttribute("aria-label"),
          ]
            .filter(Boolean)
            .map((value) => value.replace(/\s+/g, " ").trim());
          const best = labels.filter((text) => regex.test(text)).sort((a, b) => a.length - b.length)[0] || "";
          return { link, text: best };
        })
        .filter(({ text }) => text)
        .sort((a, b) => a.text.length - b.text.length);

      const match = candidates[0]?.link;
      if (!match) {
        return false;
      }

      const href = match.getAttribute("href") || "";
      if (/^javascript:/i.test(href)) {
        const code = href.replace(/^javascript:/i, "");
        Function(code).call(window);
        return true;
      }

      match.click();
      return true;
    }, pattern.source);
  } catch (error) {
    activated = /execution context|navigation|destroyed/i.test(error.message || "");
  }

  if (!activated) {
    return false;
  }

  const didNavigate = await Promise.race([navigation, page.waitForTimeout(12000).then(() => false)]);
  return activated || didNavigate;
}

async function submitScholarOneLinkByText(page, pattern, scriptPattern = null) {
  let submitted = false;
  try {
    submitted = await page.evaluate(({ source, scriptSource }) => {
      const regex = new RegExp(source, "i");
      const scriptRegex = scriptSource ? new RegExp(scriptSource, "i") : null;
      const form = document.forms[0];
      if (!form) {
        return false;
      }

      const links = Array.from(document.querySelectorAll("a"));
      const candidates = links
        .map((link) => {
          const labels = [
            link.textContent,
            link.getAttribute("title"),
            link.getAttribute("aria-label"),
          ]
            .filter(Boolean)
            .map((value) => value.replace(/\s+/g, " ").trim());
          const best = labels.filter((text) => regex.test(text)).sort((a, b) => a.length - b.length)[0] || "";
          const script = [
            link.getAttribute("href") || "",
            link.getAttribute("onclick") || "",
          ]
            .join(";")
            .replace(/^javascript:/i, "");
          return { link, text: best, script };
        })
        .filter(({ text, script }) => text && (!scriptRegex || scriptRegex.test(script)))
        .sort((a, b) => a.text.length - b.text.length);

      const link = candidates[0]?.link;
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

      const oneData = script.match(
        /setDataAndNextPageOneDataValue\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]+)['"]\)/
      );
      if (oneData) {
        setFormValue(oneData[1], decodeHtml(oneData[2]));
        setFormValue("NEXT_PAGE", oneData[3]);
        submitForm(form);
        return true;
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

      const next = script.match(/setNextPage\(['"]([^'"]+)['"]\)/);
      if (next) {
        setFormValue("NEXT_PAGE", next[1]);
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
    }, {
      source: pattern.source,
      scriptSource: scriptPattern ? scriptPattern.source : "",
    });
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

function extractManuscriptId(text) {
  const labeled = text.match(/(?:manuscript|submission|document)\s*(?:id|number)?\s*[:#]?\s*([A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?)/i);
  if (labeled) {
    return labeled[1].toUpperCase();
  }

  const generic = text.match(/\b([A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?)\b/i);
  return generic ? generic[1].toUpperCase() : null;
}

function normalizeManuscriptId(value) {
  return (value || "").toUpperCase().replace(/\s+/g, "").trim();
}

function simpleHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function extractSubmittedDate(text) {
  const patterns = [
    /date\s+submitted\s*:?\s*([0-9]{1,2}[\s-]+[A-Z][a-z]{2,8}[\s-]+[0-9]{4})/i,
    /submitted\s+date\s*:?\s*([0-9]{1,2}[\s-]+[A-Z][a-z]{2,8}[\s-]+[0-9]{4})/i,
    /submitted\s*:?\s*([0-9]{1,2}[\s-]+[A-Z][a-z]{2,8}[\s-]+[0-9]{4})/i,
    /date\s+submitted\s*:?\s*([A-Z][a-z]{2,8}[\s-]+[0-9]{1,2},?[\s-]+[0-9]{4})/i,
    /submitted\s+date\s*:?\s*([A-Z][a-z]{2,8}[\s-]+[0-9]{1,2},?[\s-]+[0-9]{4})/i,
    /submitted\s*:?\s*([A-Z][a-z]{2,8}[\s-]+[0-9]{1,2},?[\s-]+[0-9]{4})/i,
    /date\s+submitted\s*:?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})/i,
    /submitted\s+date\s*:?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})/i,
    /submitted\s*:?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})/i,
    /date\s+submitted\s*:?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
    /submitted\s+date\s*:?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
    /submitted\s*:?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    const parsed = parseDateLoose(match[1]);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function parseDateLoose(value) {
  const normalized = value
    .replace(/,/g, "")
    .replace(/(\d{1,2})-([A-Za-z]{3,9})-(\d{2,4})/g, "$1 $2 $3")
    .replace(/([A-Za-z]{3,9})-(\d{1,2})-(\d{2,4})/g, "$1 $2 $3")
    .trim();
  const direct = new Date(normalized);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const slash = normalized.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = normalizeYear(Number(slash[3]));

    const candidates = [
      new Date(Date.UTC(year, first - 1, second)),
      new Date(Date.UTC(year, second - 1, first)),
    ];

    return candidates.find((candidate) => !Number.isNaN(candidate.getTime())) || null;
  }

  return null;
}

function normalizeYear(year) {
  if (year < 100) {
    return year + 2000;
  }
  return year;
}

function daysBetweenUtcMidnights(olderDate, newerDate) {
  const older = Date.UTC(
    olderDate.getUTCFullYear(),
    olderDate.getUTCMonth(),
    olderDate.getUTCDate()
  );
  const newer = Date.UTC(
    newerDate.getUTCFullYear(),
    newerDate.getUTCMonth(),
    newerDate.getUTCDate()
  );
  return Math.floor((newer - older) / 86_400_000);
}

async function waitUntilInterrupted() {
  await new Promise((resolve) => {
    const interval = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(interval);
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      resolve();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function saveScreenshot(page, name) {
  const filename = `${name.replace(/[^a-z0-9-]+/gi, "-")}.png`;
  const absolutePath = path.join(screenshotDir, filename);
  await page.screenshot({ path: absolutePath, fullPage: true }).catch(() => undefined);
  return absolutePath;
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

function parseArgs(rawArgs) {
  const parsed = {};
  for (const arg of rawArgs) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const body = arg.slice(2);
    const equalsIndex = body.indexOf("=");
    if (equalsIndex === -1) {
      parsed[body] = true;
    } else {
      parsed[body.slice(0, equalsIndex)] = body.slice(equalsIndex + 1);
    }
  }
  return parsed;
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

function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return Object.fromEntries(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const index = line.indexOf("=");
          if (index === -1) {
            return [line, ""];
          }
          return [line.slice(0, index), line.slice(index + 1)];
        })
    );
  } catch {
    return {};
  }
}

function loadLoginCredentials(parsedArgs, parsedEnv) {
  let username = parsedArgs["login-username"] || parsedEnv.LOGIN_USERNAME || "";
  let password = parsedArgs["login-password"] || parsedEnv.LOGIN_PASSWORD || "";
  const credentialsFile = parsedArgs["login-credentials-file"] || parsedEnv.LOGIN_CREDENTIALS_FILE || "";

  if (credentialsFile && (!username || !password)) {
    const absolutePath = path.isAbsolute(credentialsFile)
      ? credentialsFile
      : path.join(projectRoot, credentialsFile);
    const content = fs.readFileSync(absolutePath, "utf8");

    if (/^\s*[A-Z0-9_]+\s*=/im.test(content)) {
      const fileEnv = Object.fromEntries(
        content
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#"))
          .map((line) => {
            const index = line.indexOf("=");
            if (index === -1) {
              return [line, ""];
            }
            return [line.slice(0, index), line.slice(index + 1)];
          })
      );
      username ||= fileEnv.LOGIN_USERNAME || fileEnv.USERNAME || "";
      password ||= fileEnv.LOGIN_PASSWORD || fileEnv.PASSWORD || "";
    } else {
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      username ||= lines[0] || "";
      password ||= lines[1] || "";
    }
  }

  return {
    username,
    password,
  };
}

function loadRejectMessage(parsedArgs, parsedEnv) {
  const messageFile = parsedArgs["reject-message-file"] || parsedEnv.REJECT_MESSAGE_FILE || "";
  if (messageFile) {
    const absolutePath = path.isAbsolute(messageFile)
      ? messageFile
      : path.join(projectRoot, messageFile);
    return fs.readFileSync(absolutePath, "utf8").trimEnd();
  }

  const inlineMessage = parsedArgs["reject-message"] || parsedEnv.REJECT_MESSAGE || "";
  if (inlineMessage) {
    return inlineMessage.replace(/\\n/g, "\n");
  }

  return DEFAULT_REJECT_MESSAGE;
}

function toInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hasMaxRejectedLimit() {
  return Number.isFinite(config.maxRejected) && config.maxRejected > 0;
}

function formatRejectedProgress(rejected) {
  return hasMaxRejectedLimit() ? `${rejected}/${config.maxRejected}` : `${rejected}`;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return /^(1|true|yes)$/i.test(value);
}
