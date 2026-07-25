// Wstępna ocena artykułów: zebranie metadanych, ocena LLM i — w trybie live —
// wykonanie decyzji w ScholarOne.
import { deriveSimulatedContinuation, runCodexAssessment } from "../llm-assessment.js";
import { buildScreeningBatchResult } from "../screening-batch.js";
import { buildAutomaticRevisionAssessment, classifyScreeningManuscript } from "../screening-assessment.js";
import { hasUnusualActivityAlert, openAndReadAbstract, readManuscriptSummary, waitForManuscriptMetadataReady } from "../screening-metadata.js";
import { approveAndAssignEditors } from "../screening-approval.js";
import { formatSingleAssessmentUsage } from "../reporting/artifacts.js";
import { clickRejectAndFillEmail, clickSaveAndSend } from "../steps/reject-email.js";
import {
  countViewDetailsControls,
  goToNextDocument,
  navigateToCompleteChecklistQueue,
  openNextUnseenViewDetailsAcrossQueuePages,
  returnToList,
  waitForDetailsPageOrRelogin,
} from "../steps/queue.js";
import path from "node:path";
import { isRevisionManuscriptId, normalizeManuscriptId } from "../manuscript-rules.js";
import { projectRoot } from "../config/defaults.js";
import { clickCompleteChecklist } from "../steps/checklist.js";
import { ensureManuscriptListReady, inspectCurrentManuscript } from "../steps/queue.js";
import { context, formatRejectedProgress, hasMaxRejectedLimit } from "./context.js";

export async function runMetadataCollection(page) {
  let checked = 0;
  let hasOpenDetailsPage = false;
  let queueExhausted = false;
  const seenManuscriptIds = new Set();
  const skippedUnusualActivity = [];
  const manuscripts = [];
  let stoppedAfterActionError = false;

  while (context.config.scanAllMetadata || checked < context.config.maxChecked) {
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
      await context.log("metadata_manuscript_skipped", {
        checked,
        ...skipped,
      });
      console.log(`[${checked}] ${manuscriptId || "NO_ID"} -> pominięty: czerwony alert unusual activity`);

      if (!context.config.scanAllMetadata && checked >= context.config.maxChecked) {
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
    const screenshot = await context.screenshots.step(page, `metadata-${summary.manuscriptId}`);

    await context.log("metadata_collected", {
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
      await context.log("revision_automatically_approved", {
        checked,
        manuscriptId: summary.manuscriptId,
        decision: assessment.decision,
        mode: assessment.mode,
        continuationAction: continuation.action,
      });
      console.log(`[AUTO APPROVE] ${summary.manuscriptId}: rewizja .R + liczba; pomijam abstrakt i LLM.`);
      logAssessmentBranch(continuation);
    } else if (context.config.assessWithLlm) {
      const llmOutputPath = path.join(
        context.config.logsDir,
        "screening",
        `${context.runId}-${summary.manuscriptId}-llm.json`
      );
      console.log(
        `[LLM] Wysyłam tytuł i abstrakt do Codex CLI (${context.config.assessmentModel}, reasoning: ${context.config.assessmentReasoningEffort})...`
      );
      try {
        assessment = await runCodexAssessment(metadata, {
          instructions: context.config.assessmentPrompt,
          model: context.config.assessmentModel,
          reasoningEffort: context.config.assessmentReasoningEffort,
          timeoutMs: context.config.assessmentTimeoutSeconds * 1000,
          outputPath: llmOutputPath,
          cwd: projectRoot,
        });
        continuation = deriveSimulatedContinuation(assessment.decision);

        await context.log("llm_assessment_completed", {
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
        await context.log("llm_assessment_failed", {
          checked,
          manuscriptId: summary.manuscriptId,
          message: error.message,
          llmOutputPath,
          llmEventsPath: error.eventsPath || null,
        });
        console.error(`[LLM ERROR] ${summary.manuscriptId}: ${error.message}`);
      }
    }

    if (context.config.applyAssessmentDecisions && assessment && !assessmentError) {
      console.log(`[LIVE ACTION] ${summary.manuscriptId}: wykonuję ${assessment.decision} w ScholarOne...`);
      try {
        decisionAction = await applyLiveAssessmentDecision(page, assessment);
        decisionAction.screenshot = await context.screenshots.proof(
          page,
          `live-action-complete-${assessment.decision.toLowerCase()}-${summary.manuscriptId}`
        );
        await context.log("assessment_live_action_completed", {
          checked,
          manuscriptId: summary.manuscriptId,
          decision: assessment.decision,
          decisionAction,
        });
        console.log(`[LIVE ACTION COMPLETE] ${summary.manuscriptId}: ${assessment.decision}.`);
      } catch (error) {
        const actionScreenshot = await context.screenshots.error(page, `live-action-error-${summary.manuscriptId}`);
        actionError = {
          decision: assessment.decision,
          message: error.message,
          pageUrl: page.url(),
          screenshot: actionScreenshot,
        };
        stoppedAfterActionError = true;
        await context.log("assessment_live_action_failed", {
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

    await context.log("metadata_batch_progress", {
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

    if (!context.config.scanAllMetadata && checked >= context.config.maxChecked) {
      break;
    }

    if (context.config.applyAssessmentDecisions && decisionAction?.completed) {
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
    assessWithLlm: context.config.assessWithLlm,
    applyAssessmentDecisions: context.config.applyAssessmentDecisions,
    scanAll: context.config.scanAllMetadata,
    maxChecked: context.config.maxChecked,
    queueExhausted,
  });
}

export function logAssessmentBranch(continuation) {
  const suffix = context.config.applyAssessmentDecisions
    ? "tryb live: decyzja zostanie wykonana w ScholarOne"
    : "dry run: bez kliknięcia w ScholarOne";
  console.log(`[WORKFLOW BRANCH] ${continuation.action} (${suffix})`);
}

export async function applyLiveAssessmentDecision(page, assessment) {
  const checklistResult = await clickCompleteChecklist(page);

  if (assessment.decision === "APPROVE") {
    const approvalResult = await approveAndAssignEditors(page, {
      editorName: context.config.screeningEditorName,
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
    const rejectResultWithPage = await clickRejectAndFillEmail(page, context.config.screeningRejectMessage);
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
