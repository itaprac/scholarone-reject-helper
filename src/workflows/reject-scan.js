// Przejście kolejki Complete Checklist: sprawdzenie reguł i — poza dry-runem —
// odrzucenie pasujących manuskryptów.
import { inspectManuscriptText, isRevisionManuscriptId } from "../manuscript-rules.js";
import { createReportSummary, recordReportDecision } from "../reporting/report.js";
import { clickCompleteChecklist, isNoRejectControlChecklistResult } from "../steps/checklist.js";
import { clickRejectAndFillEmail, clickSaveAndSend, countRejectControls } from "../steps/reject-email.js";
import {
  advanceQueueListPage,
  countViewDetailsControls,
  ensureManuscriptListReady,
  goToQueueListPage,
  inspectCurrentManuscript,
  navigateToCompleteChecklistQueue,
  openNextUnseenViewDetails,
  openNextUnseenViewDetailsAcrossQueuePages,
  readQueuePageInfo,
  returnToList,
  waitForDetailsPage,
} from "../steps/queue.js";
import { dismissCookieBanner, goToNextDocument, waitForDetailsPageOrRelogin } from "../steps/queue.js";
import { isLoginPage } from "../core/login.js";
import { context, formatRejectedProgress, hasMaxRejectedLimit } from "./context.js";

export async function runScan(page) {
  let checked = 0;
  let rejected = 0;
  let hasOpenDetailsPage = false;
  const seenManuscriptIds = new Set();
  const report = createReportSummary();
  const maxAttempts = Math.max(context.config.maxChecked * 4, context.config.maxChecked + 20);
  let attempts = 0;
  let queueStartPageApplied = false;

  while (checked < context.config.maxChecked && attempts < maxAttempts) {
    attempts += 1;

    if (!hasOpenDetailsPage) {
      await dismissCookieBanner(page);
      await ensureManuscriptListReady(page);

      if (!queueStartPageApplied && context.config.queueStartPage > 0) {
        const pageChange = await goToQueueListPage(page, String(context.config.queueStartPage));
        await context.log("queue_start_page_applied", {
          requestedPage: context.config.queueStartPage,
          ...pageChange,
        });
        if (pageChange.changed) {
          await ensureManuscriptListReady(page);
        }
        queueStartPageApplied = true;
      }

      if (context.config.stopAfterQueue) {
        const screenshot = await context.screenshots.step(page, "queue-ready");
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
      await context.ensureLoggedIn(page, { reason: "before-inspect" });
      hasOpenDetailsPage = false;
      continue;
    }

    const details = await inspectCurrentManuscript(page);
    const manuscriptKey = details.manuscriptId ? details.manuscriptId.toUpperCase() : null;

    if (manuscriptKey && seenManuscriptIds.has(manuscriptKey)) {
      await context.log("duplicate_manuscript_skipped", {
        attempts,
        checked,
        manuscriptId: manuscriptKey,
      });

      const movedNext = await goToNextDocument(page);
      if (!movedNext) {
        await context.log("next_document_unavailable", {
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

    await context.log("manuscript_checked", {
      rowIndex: checked - 1,
      attempts,
      ...details,
    });

    console.log(
      `[${checked}] ${details.manuscriptId || "NO_ID"} -> ${details.action}: ${details.reason}`
    );

    if (details.action === "skip") {
      if (checked >= context.config.maxChecked) {
        break;
      }

      const movedNext = await goToNextDocument(page);
      if (!movedNext) {
        await context.log("next_document_unavailable", {
          checked,
          manuscriptId: details.manuscriptId,
        });
        await returnToList(page);
        hasOpenDetailsPage = false;
      }
      continue;
    }

    if (details.action !== "candidate") {
      const screenshot = await context.screenshots.error(page, `needs-review-${checked}`);
      return {
        status: "needs_manual_review",
        checked,
        rejected,
        details,
        report,
        screenshot,
      };
    }

    if (context.config.reportOnly) {
      console.log(
        `[${checked}] ${details.manuscriptId || "NO_ID"} -> report-only: WOULD REJECT (${details.reason})`
      );
      await context.log("report_only_candidate", {
        rowIndex: checked - 1,
        details,
      });

      if (checked >= context.config.maxChecked) {
        break;
      }

      const movedNext = await goToNextDocument(page);
      if (!movedNext) {
        await context.log("next_document_unavailable_report_only", {
          checked,
          manuscriptId: details.manuscriptId,
        });
        await returnToList(page);
        hasOpenDetailsPage = false;
      }
      continue;
    }

    const checklistResult = await clickCompleteChecklist(page);

    if (!context.config.clickReject) {
      const screenshot = await context.screenshots.step(page, `candidate-before-reject-${checked}`);

      await context.log("stopped_before_reject", {
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

    const rejectEmailResultWithPage = await clickRejectAndFillEmail(page, context.config.rejectMessage);
    const { emailPage, ...rejectEmailResult } = rejectEmailResultWithPage;

    if (!rejectEmailResult.clicked || !rejectEmailResult.emailBodyFilled) {
      const screenshot = await context.screenshots.error(emailPage || page, `candidate-reject-step-failed-${checked}`);

      await context.log("reject_step_failed", {
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

    if (!context.config.saveAndSend) {
      const screenshot = await context.screenshots.step(emailPage || page, `candidate-email-filled-${checked}`);

      await context.log("stopped_before_send", {
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

    if (hasMaxRejectedLimit() && rejected >= context.config.maxRejected) {
      const screenshot = await context.screenshots.step(emailPage || page, `candidate-max-rejected-reached-${checked}`);

      return {
        status: "max_rejected_reached_before_send",
        checked,
        rejected,
        details,
        report,
        checklistResult,
        rejectEmailResult,
        screenshot,
        note: `Safety stop: maxRejected=${context.config.maxRejected} was reached before Save and Send.`,
      };
    }

    const sendResult = await clickSaveAndSend(emailPage, page);
    if (!sendResult.sent) {
      const screenshot = await context.screenshots.error(sendResult.emailPageClosed ? page : emailPage || page, `candidate-save-send-failed-${checked}`);

      await context.log("save_send_failed", {
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
    const screenshot = await context.screenshots.proof(page, `candidate-sent-${checked}`);

    await context.log("candidate_rejected_and_sent", {
      rowIndex: checked - 1,
      details,
      checklistResult,
      rejectEmailResult,
      sendResult,
      screenshot,
      rejected,
    });

    console.log(`[${checked}] ${details.manuscriptId || "NO_ID"} -> sent: Reject email sent (${formatRejectedProgress(rejected)}).`);

    if (hasMaxRejectedLimit() && rejected >= context.config.maxRejected) {
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
        note: `Safety stop: reached maxRejected=${context.config.maxRejected}.`,
      };
    }

    if (checked >= context.config.maxChecked) {
      break;
    }

    const movedNext = await goToNextDocument(page);
    if (!movedNext) {
      await context.log("next_document_unavailable_after_send", {
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
    status: context.config.dryRun ? "dry_run_finished" : context.config.reportOnly ? "report_only_finished" : "max_checked_reached",
    checked,
    rejected,
    report,
  };
}
