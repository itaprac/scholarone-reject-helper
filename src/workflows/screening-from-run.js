// Wykonanie decyzji z wcześniej zapisanego przebiegu oceny.
//
// Dotąd screening dawał wybór: dry run bez skutków albo live, który ocenia i od
// razu działa. Nie było ścieżki pośredniej, którą odrzucanie ma od dawna:
// zobacz wynik, sprawdź go, dopiero potem wykonaj.
//
// Ten workflow nie woła modelu ponownie. Bierze decyzje z pliku, wyszukuje
// każdy manuskrypt po ID i wykonuje na nim dokładnie to, co zatwierdziłeś.
import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeManuscriptId } from "../manuscript-rules.js";
import { createActionLog } from "../core/action-log.js";
import { createLiveGuard, isLiveActionLimit } from "../core/live-guard.js";
import { resolveProjectPath } from "../core/env.js";
import {
  loadScreeningProgress,
  markScreeningProgress,
  screeningResumeDecision,
} from "../screening-progress.js";
import {
  inspectCurrentManuscript,
  navigateToAdminQueue,
  openViewDetailsByManuscriptIdAcrossQueuePages,
  waitForDetailsPageOrRelogin,
} from "../steps/queue.js";
import { applyLiveAssessmentDecision, screeningActionName } from "./screening.js";
import { context } from "./context.js";
import { assessmentProgressPath, assessmentWorkflowName } from "../assessment-stage.js";

export async function runScreeningFromRun(page) {
  const source = context.config.screeningFromRun;
  if (!source) {
    throw new Error("Ten tryb wymaga --from-run=logs/screening/PLIK.json");
  }

  const decisions = await loadDecisions(source, context.config.assessmentStage);
  if (decisions.length === 0) {
    return {
      status: "screening_run_has_no_decisions",
      source,
      checked: 0,
      results: [],
      note: "Zapisany przebieg nie zawiera decyzji do wykonania.",
    };
  }

  const actionLog = createActionLog(context.config.logsDir);
  const progressPath = assessmentProgressPath(context.config);
  const progress = await loadScreeningProgress(progressPath);
  const liveGuard = createLiveGuard({ limit: context.config.maxLiveActions });

  await context.log("screening_from_run_started", {
    source,
    decisions: decisions.length,
    maxLiveActions: liveGuard.limit,
  });
  console.log(`[FROM RUN] ${decisions.length} decyzji z ${source}`);

  const results = [];
  let performed = 0;
  let status = "screening_from_run_finished";

  await navigateToAdminQueue(page, context.config.assessmentQueueLabel);

  for (const [index, decision] of decisions.entries()) {
    const position = index + 1;
    const manuscriptId = decision.manuscriptId;

    const resume = screeningResumeDecision(progress, manuscriptId);
    if (resume.action === "skip") {
      results.push({ manuscriptId, status: "skipped_already_done", reason: resume.reason });
      console.log(`[${position}] ${manuscriptId} -> pomijam, poprzednio: ${resume.reason}`);
      continue;
    }
    if (resume.action === "needs_manual_check") {
      status = "needs_manual_review";
      results.push({ manuscriptId, status: "needs_manual_check", reason: resume.reason });
      console.error(`[${position}] ${manuscriptId} -> ${resume.reason}`);
      break;
    }

    try {
      liveGuard.assertCanProceed(decision.decision);
    } catch (error) {
      if (!isLiveActionLimit(error)) throw error;
      status = "max_live_actions_reached";
      results.push({ manuscriptId, status: "stopped_at_limit", reason: error.message });
      console.log(`[${position}] ${error.message}`);
      break;
    }

    const opened = await openViewDetailsByManuscriptIdAcrossQueuePages(page, manuscriptId);
    if (!opened) {
      // Manuskrypt zniknął z kolejki między oceną a wykonaniem — najczęściej
      // dlatego, że ktoś obsłużył go ręcznie. To nie jest błąd przebiegu.
      results.push({ manuscriptId, status: "not_found_in_queue" });
      await context.log("screening_from_run_not_found", { manuscriptId });
      console.log(`[${position}] ${manuscriptId} -> nie ma go już w kolejce, pomijam`);
      await navigateToAdminQueue(page, context.config.assessmentQueueLabel);
      continue;
    }

    const detailsReady = await waitForDetailsPageOrRelogin(page, `from-run-open-${manuscriptId}`);
    if (!detailsReady) {
      results.push({ manuscriptId, status: "login_interrupted_open_details" });
      await context.log("screening_from_run_login_interrupted", { manuscriptId });
      await navigateToAdminQueue(page, context.config.assessmentQueueLabel);
      continue;
    }

    // Akcja nieodwracalna wymaga pewności, że otwarta strona to właściwy
    // artykuł, a nie inny wynik wyszukiwania.
    const details = await inspectCurrentManuscript(page);
    if (normalizeManuscriptId(details.manuscriptId) !== manuscriptId) {
      results.push({
        manuscriptId,
        status: "id_mismatch",
        foundManuscriptId: details.manuscriptId,
      });
      await context.log("screening_from_run_id_mismatch", {
        manuscriptId,
        foundManuscriptId: details.manuscriptId,
      });
      console.error(`[${position}] ${manuscriptId} -> otwarto ${details.manuscriptId || "inny artykuł"}, pomijam`);
      await navigateToAdminQueue(page, context.config.assessmentQueueLabel);
      continue;
    }

    await markScreeningProgress(progress, progressPath, manuscriptId, {
      status: "attempted",
      decision: decision.decision,
      runId: context.runId,
      source,
    });

    console.log(`[${position}] ${manuscriptId} -> wykonuję ${decision.decision}...`);

    try {
      const action = await applyLiveAssessmentDecision(page, {
        decision: decision.decision,
        reason: decision.reason,
        mode: decision.mode,
      });
      action.screenshot = await context.screenshots.proof(
        page,
        `from-run-${decision.decision.toLowerCase()}-${manuscriptId}`
      );

      liveGuard.recordPerformed();
      performed += 1;

      await markScreeningProgress(progress, progressPath, manuscriptId, {
        status: decision.decision === "REJECT" ? "rejected" : "approved",
        decision: decision.decision,
        runId: context.runId,
        source,
      });
      await actionLog.record({
        runId: context.runId,
        mode: `${assessmentWorkflowName(context.config)}-from-run`,
        manuscriptId,
        action: screeningActionName(decision),
        outcome: "sent",
        confirmed: true,
        detail: decision.reason,
      });

      results.push({ manuscriptId, status: "done", decision: decision.decision, action });
      console.log(`[${position}] ${manuscriptId} -> ${decision.decision} wykonane (${liveGuard.describe()}).`);
    } catch (error) {
      const screenshot = await context.screenshots.error(page, `from-run-error-${manuscriptId}`);
      await actionLog.record({
        runId: context.runId,
        mode: `${assessmentWorkflowName(context.config)}-from-run`,
        manuscriptId,
        action: screeningActionName(decision),
        outcome: "failed",
        confirmed: false,
        detail: error.message,
      });
      await context.log("screening_from_run_action_failed", {
        manuscriptId,
        decision: decision.decision,
        message: error.message,
        screenshot,
      });

      // Wpis zostaje "attempted": nie wiadomo, czy wiadomość wyszła, więc
      // wznowienie ma to zgłosić, a nie powtórzyć.
      status = "action_failed";
      results.push({ manuscriptId, status: "failed", decision: decision.decision, message: error.message, screenshot });
      console.error(`[${position}] ${manuscriptId} -> ${error.message}`);
      break;
    }

    await navigateToAdminQueue(page, context.config.assessmentQueueLabel);
  }

  return {
    status,
    source,
    checked: decisions.length,
    performed,
    liveActions: liveGuard.describe(),
    results,
  };
}

// Z zapisanego przebiegu bierzemy tylko to, co da się wykonać: rekordy z
// decyzją i bez błędu oceny. Artykuły, które w tamtym przebiegu już dostały
// akcję, są pomijane — inaczej wykonalibyśmy je drugi raz.
export function extractExecutableDecisions(payload) {
  const manuscripts = payload?.result?.manuscripts || [];

  return manuscripts
    .filter((entry) => entry.assessment?.decision && !entry.assessmentError && !entry.decisionAction?.completed)
    .map((entry) => ({
      manuscriptId: normalizeManuscriptId(entry.metadata?.manuscriptId || ""),
      decision: entry.assessment.decision,
      reason: entry.assessment.reason || "",
      mode: entry.assessment.mode || null,
    }))
    .filter((entry) => entry.manuscriptId);
}

async function loadDecisions(source, expectedStage) {
  const absolutePath = resolveProjectPath(source);
  const raw = await fsp.readFile(absolutePath, "utf8").catch(() => null);
  if (raw === null) {
    throw new Error(`Nie udało się odczytać zapisanego przebiegu: ${path.basename(source)}`);
  }

  const payload = JSON.parse(raw);
  const artifactStage = payload.config?.assessmentStage || "initial";
  if (artifactStage !== expectedStage) {
    throw new Error(
      `Zapisany przebieg jest z etapu ${artifactStage}, a uruchomiono etap ${expectedStage}.`
    );
  }

  return extractExecutableDecisions(payload);
}
