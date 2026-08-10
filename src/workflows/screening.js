// Wstępna ocena artykułów: zebranie metadanych, ocena LLM i — w trybie live —
// wykonanie decyzji w ScholarOne.
import { deriveSimulatedContinuation } from "../llm-assessment.js";
import { createAssessmentProvider } from "../assessment/provider.js";
import { createTaskPool } from "../assessment/pool.js";
import { buildScreeningBatchResult } from "../screening-batch.js";
import { buildAutomaticRevisionAssessment, classifyScreeningManuscript } from "../screening-assessment.js";
import { hasUnusualActivityAlert, openAndReadAbstract, readManuscriptSummary, waitForManuscriptMetadataReady } from "../screening-metadata.js";
import { approveAndAssignEditors } from "../screening-approval.js";
import { formatSingleAssessmentUsage } from "../reporting/artifacts.js";
import { clickRejectAndFillEmail, clickSaveAndSend } from "../steps/reject-email.js";
import {
  goToNextDocument,
  isCompleteChecklistQueueEmpty,
  openNextUnseenViewDetailsAcrossQueuePages,
  returnToList,
  waitForDetailsPageOrRelogin,
} from "../steps/queue.js";
import { isRevisionManuscriptId, normalizeManuscriptId } from "../manuscript-rules.js";
import { clickCompleteChecklist } from "../steps/checklist.js";
import { ensureManuscriptListReady, inspectCurrentManuscript } from "../steps/queue.js";
import { createActionLog } from "../core/action-log.js";
import { createLiveGuard } from "../core/live-guard.js";
import {
  loadScreeningProgress,
  markScreeningProgress,
  screeningProgressPath,
  screeningResumeDecision,
} from "../screening-progress.js";
import { context } from "./context.js";

export async function runMetadataCollection(page) {
  const provider = createAssessmentProvider(context.config, {
    runId: context.runId,
    log: context.log,
  });

  const actionLog = createActionLog(context.config.logsDir);
  const progressPath = screeningProgressPath(context.config.logsDir);
  const progress = await loadScreeningProgress(progressPath);
  const liveGuard = createLiveGuard({
    limit: context.config.applyAssessmentDecisions ? context.config.maxLiveActions : null,
  });

  // W trybie live ocena musi poprzedzać kliknięcie na otwartej stronie, więc
  // pula jest wtedy jednoelementowa i pętla zachowuje się jak dotąd.
  const pool = createTaskPool({
    concurrency: context.config.applyAssessmentDecisions
      ? 1
      : context.config.assessmentConcurrency || 3,
  });

  let checked = 0;
  let hasOpenDetailsPage = false;
  let queueExhausted = false;
  const seenManuscriptIds = new Set();
  const skippedUnusualActivity = [];
  const manuscripts = [];
  let stoppedAfterActionError = false;

  while (context.config.scanAllMetadata || checked < context.config.maxChecked) {
    if (!hasOpenDetailsPage) {
      try {
        await ensureManuscriptListReady(page);
      } catch (error) {
        if (await detectExhaustedCompleteChecklist(page, error, checked)) {
          queueExhausted = true;
          break;
        }
        throw error;
      }
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
        if (await returnToListOrDetectExhausted(page, checked)) {
          queueExhausted = true;
          break;
        }
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
        if (await returnToListOrDetectExhausted(page, checked)) {
          queueExhausted = true;
          break;
        }
        hasOpenDetailsPage = false;
      }
      continue;
    }

    const summary = await readManuscriptSummary(page);
    if (!summary.manuscriptId || !summary.title) {
      throw new Error(summary.reason || "Nie udało się odczytać tytułu manuskryptu.");
    }

    // Wznowienie po przerwanym przebiegu live: artykuł z potwierdzoną akcją
    // pomijamy, a taki z akcją rozpoczętą i niepotwierdzoną zatrzymuje przebieg,
    // bo tylko człowiek może sprawdzić, czy wiadomość wyszła.
    if (context.config.applyAssessmentDecisions) {
      const resume = screeningResumeDecision(progress, summary.manuscriptId);

      if (resume.action === "skip") {
        await context.log("screening_resume_skipped", {
          checked,
          manuscriptId: summary.manuscriptId,
          reason: resume.reason,
          at: resume.at,
        });
        console.log(`[RESUME] ${summary.manuscriptId} -> pomijam, poprzednio: ${resume.reason}`);

        const movedNextResume = await goToNextDocument(page);
        if (!movedNextResume) {
          if (await returnToListOrDetectExhausted(page, checked)) {
            queueExhausted = true;
            break;
          }
          hasOpenDetailsPage = false;
        }
        continue;
      }

      if (resume.action === "needs_manual_check") {
        await context.log("screening_resume_needs_manual_check", {
          checked,
          manuscriptId: summary.manuscriptId,
          reason: resume.reason,
          at: resume.at,
        });
        throw new Error(
          `${summary.manuscriptId}: ${resume.reason} Sprawdź ręcznie w ScholarOne, popraw wpis w ${progressPath} i uruchom ponownie.`
        );
      }
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

    // Rekord trafia do wyniku od razu, a ocena dopisuje się do niego później.
    // Dzięki temu w dry-runie przeglądarka może iść dalej, nie czekając na model.
    const record = {
      metadata,
      assessment: null,
      continuation: null,
      assessmentError: null,
      decisionAction: null,
      actionError: null,
      screenshot,
    };

    // Ocena odłożona: tylko wtedy, gdy nic nie zależy od jej wyniku na tej
    // stronie. W trybie live decyzja musi być znana przed kliknięciem.
    const deferAssessment =
      !isRevision && context.config.assessWithLlm && !context.config.applyAssessmentDecisions;

    if (deferAssessment) {
      manuscripts.push(record);
      const checkedAt = checked;
      await pool.add(() => assessIntoRecord(provider, record, checkedAt));

      await context.log("metadata_batch_progress", {
        checked,
        eligibleCount: manuscripts.length,
        skippedUnusualActivityCount: skippedUnusualActivity.length,
        latestManuscriptId: summary.manuscriptId,
        assessmentDeferred: true,
        assessmentsPending: pool.pending,
      });

      if (!context.config.scanAllMetadata && checked >= context.config.maxChecked) {
        break;
      }

      const movedNextDeferred = await goToNextDocument(page);
      if (!movedNextDeferred) {
        if (await returnToListOrDetectExhausted(page, checked)) {
          queueExhausted = true;
          break;
        }
        hasOpenDetailsPage = false;
      }
      continue;
    }

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
      const llmOutputPath = provider.outputPathFor(summary.manuscriptId);
      console.log(
        `[LLM] Wysyłam tytuł i abstrakt do modelu (${context.config.assessmentModel}, reasoning: ${context.config.assessmentReasoningEffort})...`
      );
      try {
        assessment = await provider.assess(metadata);
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
        if (assessment.cached) {
          console.log(`[LLM CACHE] wynik z ${assessment.cachedAt} — bez ponownego wywołania modelu`);
        } else {
          console.log(`[LLM USAGE] ${formatSingleAssessmentUsage(assessment.usage)}, czas=${assessment.durationMs} ms`);
        }
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
      // Limit sprawdzany przed akcją, a nie po niej — inaczej operacja o jedną
      // za dużo zdążyłaby się już wykonać.
      liveGuard.assertCanProceed(assessment.decision);

      // Ślad zapisany przed kliknięciem: gdyby przebieg tu padł, wznowienie
      // zobaczy "attempted" i zgłosi artykuł do ręcznego sprawdzenia zamiast
      // powtarzać akcję.
      await markScreeningProgress(progress, progressPath, summary.manuscriptId, {
        status: "attempted",
        decision: assessment.decision,
        runId: context.runId,
      });

      console.log(`[LIVE ACTION] ${summary.manuscriptId}: wykonuję ${assessment.decision} w ScholarOne...`);
      try {
        decisionAction = await applyLiveAssessmentDecision(page, assessment);
        decisionAction.screenshot = await context.screenshots.proof(
          page,
          `live-action-complete-${assessment.decision.toLowerCase()}-${summary.manuscriptId}`
        );

        liveGuard.recordPerformed();
        await markScreeningProgress(progress, progressPath, summary.manuscriptId, {
          status: assessment.decision === "REJECT" ? "rejected" : "approved",
          decision: assessment.decision,
          runId: context.runId,
        });
        await actionLog.record({
          runId: context.runId,
          mode: "screening-live",
          manuscriptId: summary.manuscriptId,
          action: screeningActionName(assessment),
          outcome: "sent",
          confirmed: true,
          detail: assessment.reason,
        });

        await context.log("assessment_live_action_completed", {
          checked,
          manuscriptId: summary.manuscriptId,
          decision: assessment.decision,
          liveActions: liveGuard.describe(),
          decisionAction,
        });
        console.log(`[LIVE ACTION COMPLETE] ${summary.manuscriptId}: ${assessment.decision} (${liveGuard.describe()}).`);
      } catch (error) {
        const actionScreenshot = await context.screenshots.error(page, `live-action-error-${summary.manuscriptId}`);
        actionError = {
          decision: assessment.decision,
          message: error.message,
          pageUrl: page.url(),
          screenshot: actionScreenshot,
        };
        stoppedAfterActionError = true;

        // Stan zostaje "attempted": automat nie wie, czy wiadomość wyszła, więc
        // wznowienie ma to zgłosić do ręcznego sprawdzenia, a nie powtórzyć.
        await actionLog.record({
          runId: context.runId,
          mode: "screening-live",
          manuscriptId: summary.manuscriptId,
          action: screeningActionName(assessment),
          outcome: "failed",
          confirmed: false,
          detail: error.message,
        });
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
      if (await returnToListOrDetectExhausted(page, checked)) {
        queueExhausted = true;
        break;
      }
      hasOpenDetailsPage = false;
      continue;
    }

    const movedNext = await goToNextDocument(page);
    if (!movedNext) {
      if (await returnToListOrDetectExhausted(page, checked)) {
        queueExhausted = true;
        break;
      }
      hasOpenDetailsPage = false;
    }
  }

  // Odłożone oceny muszą się domknąć, zanim powstanie raport — inaczej trafiłby
  // do niego rekord bez decyzji.
  const drained = await pool.drain();
  if (drained.results.length > 0) {
    await context.log("assessment_pool_drained", {
      assessments: drained.results.length,
      failures: drained.failures,
    });
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

async function returnToListOrDetectExhausted(page, checked) {
  try {
    await returnToList(page);
    return false;
  } catch (error) {
    if (await detectExhaustedCompleteChecklist(page, error, checked)) {
      return true;
    }
    throw error;
  }
}

async function detectExhaustedCompleteChecklist(page, error, checked) {
  if (!(await isCompleteChecklistQueueEmpty(page))) {
    return false;
  }
  await context.log("metadata_queue_exhausted", {
    checked,
    reason: "Complete Checklist count is 0",
    previousError: error?.message || null,
  });
  console.log("[QUEUE] Complete Checklist jest puste — kończę Initial Assessment poprawnie.");
  return true;
}

// Ocena wykonywana poza pętlą przeglądarki. Wynik dopisuje się do rekordu, który
// jest już w wyniku przebiegu; błąd modelu nie przerywa pozostałych ocen.
async function assessIntoRecord(provider, record, checked) {
  const { manuscriptId } = record.metadata;
  const llmOutputPath = provider.outputPathFor(manuscriptId);

  try {
    const assessment = await provider.assess(record.metadata);
    record.assessment = assessment;
    record.continuation = deriveSimulatedContinuation(assessment.decision);

    await context.log("llm_assessment_completed", {
      checked,
      manuscriptId,
      provider: assessment.provider,
      model: assessment.model,
      reasoningEffort: assessment.reasoningEffort,
      mode: assessment.mode,
      decision: assessment.decision,
      reason: assessment.reason,
      durationMs: assessment.durationMs,
      usage: assessment.usage,
      cached: Boolean(assessment.cached),
      threadId: assessment.threadId,
      eventCount: assessment.eventCount,
      continuationAction: record.continuation.action,
      llmOutputPath,
      llmEventsPath: assessment.eventsPath,
    });

    const usage = assessment.cached
      ? `cache z ${assessment.cachedAt}`
      : `${formatSingleAssessmentUsage(assessment.usage)}, czas=${assessment.durationMs} ms`;
    console.log(`[LLM RESULT] ${manuscriptId} ${assessment.decision}: ${assessment.reason}`);
    console.log(`[LLM USAGE] ${manuscriptId} ${usage}`);
    logAssessmentBranch(record.continuation);
  } catch (error) {
    record.assessmentError = {
      message: error.message,
      outputPath: llmOutputPath,
      eventsPath: error.eventsPath || null,
    };
    await context.log("llm_assessment_failed", {
      checked,
      manuscriptId,
      message: error.message,
      llmOutputPath,
      llmEventsPath: error.eventsPath || null,
    });
    console.error(`[LLM ERROR] ${manuscriptId}: ${error.message}`);
  }
}

export function logAssessmentBranch(continuation) {
  const suffix = context.config.applyAssessmentDecisions
    ? "tryb live: decyzja zostanie wykonana w ScholarOne"
    : "dry run: bez kliknięcia w ScholarOne";
  console.log(`[WORKFLOW BRANCH] ${continuation.action} (${suffix})`);
}

// Nazwa akcji do action-logu: approve bez dobrania edytorów to inna operacja
// niż pełne approve-and-assign i log ma je rozróżniać. Rewizje zawsze dostają
// pełny przebieg, więc opcja approveWithoutAssign ich nie dotyczy.
export function screeningActionName(assessment) {
  if (assessment.decision === "REJECT") return "reject-email";
  return context.config.approveWithoutAssign && assessment.mode !== "automatic-revision"
    ? "approve-awaiting-assignment"
    : "approve-and-assign";
}

export async function applyLiveAssessmentDecision(page, assessment) {
  const checklistResult = await clickCompleteChecklist(page);

  if (assessment.decision === "APPROVE") {
    const skipEditorAssignment =
      context.config.approveWithoutAssign && assessment.mode !== "automatic-revision";
    const approvalResult = await approveAndAssignEditors(page, {
      editorName: context.config.screeningEditorName,
      allowExistingAssignments: assessment.mode === "automatic-revision",
      skipEditorAssignment,
    });
    if (approvalResult.awaitingEditorAssignment) {
      console.log("[APPROVE ONLY] Artykuł czeka w Awaiting EIC Assignment na ręczne dobranie edytorów.");
    }
    return {
      completed: true,
      decision: "APPROVE",
      awaitingEditorAssignment: Boolean(approvalResult.awaitingEditorAssignment),
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
