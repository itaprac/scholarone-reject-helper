// Odrzucanie po ID z wcześniejszego raportu. Każdy manuskrypt jest wyszukiwany
// po ID i ponownie sprawdzany regułami, zanim cokolwiek zostanie wysłane.
import { inspectManuscriptText } from "../manuscript-rules.js";
import { createReportSummary, recordReportDecision } from "../reporting/report.js";
import { clickCompleteChecklist, isNoRejectControlChecklistResult } from "../steps/checklist.js";
import { clickRejectAndFillEmail, clickSaveAndSend, countRejectControls } from "../steps/reject-email.js";
import { inspectCurrentManuscript, navigateToCompleteChecklistQueue } from "../steps/queue.js";
import {
  getRejectProgressEntry,
  getRejectProgressPath,
  isTerminalRejectProgress,
  loadRejectProgress,
  loadRejectTargets,
  markRejectProgress,
} from "../reject-progress.js";
import { normalizeManuscriptId } from "../manuscript-rules.js";
import { openViewDetailsByIndex, waitForDetailsPageOrRelogin } from "../steps/queue.js";
import { createActionLog } from "../core/action-log.js";
import { context, formatRejectedProgress, hasMaxRejectedLimit } from "./context.js";

export async function runRejectTargetsFromSearch(page) {
  const targets = await loadRejectTargets(context.config);
  const progressPath = getRejectProgressPath(targets, context.config, context.reportDir);
  const progress = await loadRejectProgress(progressPath, targets, context.config);
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

    if (!context.config.reportOnly && hasMaxRejectedLimit() && rejected >= context.config.maxRejected) {
      return {
        status: "max_rejected_reached",
        checked,
        rejected,
        targets: targets.length,
        results,
        report,
        rejectProgressFile: progressPath,
        note: `Safety stop: reached maxRejected=${context.config.maxRejected}.`,
      };
    }

    const searchResult = await context.quickSearchManuscript(page, manuscriptId);
    if (!searchResult.found) {
      results.push({
        manuscriptId,
        status: "not_found",
        searchResult,
      });
      await context.log("search_target_not_found", {
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
      await context.log("search_target_view_details_not_found", {
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
      await context.log("search_target_id_mismatch", {
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

    if (context.config.reportOnly) {
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
      const screenshot = await context.screenshots.step(page, `search-not-actionable-no-reject-${checked}`);
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
      }, context.config);
      await context.log("search_target_not_actionable_no_reject_control", {
        manuscriptId,
        details,
        checklistResult,
        screenshot,
      });
      console.log(`[search:${checked}] ${details.manuscriptId || manuscriptId} -> skip: no Reject control, probably already processed.`);
      continue;
    }

    if (!context.config.clickReject) {
      const screenshot = await context.screenshots.step(page, `search-candidate-before-reject-${checked}`);
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

    const rejectEmailResultWithPage = await clickRejectAndFillEmail(page, context.config.rejectMessage);
    const { emailPage, ...rejectEmailResult } = rejectEmailResultWithPage;

    if (!rejectEmailResult.clicked || !rejectEmailResult.emailBodyFilled) {
      const screenshot = await context.screenshots.error(emailPage || page, `search-reject-step-failed-${checked}`);
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

    if (!context.config.saveAndSend) {
      const screenshot = await context.screenshots.step(emailPage || page, `search-email-filled-${checked}`);
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
      const screenshot = await context.screenshots.error(sendResult.emailPageClosed ? page : emailPage || page, `search-save-send-failed-${checked}`);
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
    await createActionLog(context.config.logsDir).record({
      runId: context.runId,
      mode: "reject-from-report",
      manuscriptId,
      action: "reject-email",
      outcome: "sent",
      confirmed: true,
      detail: details.reason || null,
    });
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
    }, context.config);
    console.log(`[search:${checked}] ${details.manuscriptId || manuscriptId} -> sent (${formatRejectedProgress(rejected)}).`);
  }

  return {
    status: context.config.dryRun ? "search_dry_run_finished" : context.config.reportOnly ? "search_report_finished" : "search_reject_finished",
    checked,
    rejected,
    targets: targets.length,
    results,
    report,
    rejectProgressFile: progressPath,
  };
}
