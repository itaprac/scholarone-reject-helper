export function buildScreeningBatchResult({
  checked,
  skippedUnusualActivity,
  manuscripts,
  assessWithLlm,
  applyAssessmentDecisions = false,
  scanAll,
  maxChecked,
  queueExhausted,
}) {
  const approved = manuscripts.filter((entry) => entry.assessment?.decision === "APPROVE").length;
  const rejected = manuscripts.filter((entry) => entry.assessment?.decision === "REJECT").length;
  const assessmentErrors = manuscripts.filter((entry) => entry.assessmentError).length;
  const actionErrors = manuscripts.filter((entry) => entry.actionError).length;
  const liveApproved = manuscripts.filter(
    (entry) => entry.decisionAction?.completed && entry.decisionAction?.decision === "APPROVE"
  ).length;
  const liveRejected = manuscripts.filter(
    (entry) => entry.decisionAction?.completed && entry.decisionAction?.decision === "REJECT"
  ).length;
  const liveApprovedAwaitingAssignment = manuscripts.filter(
    (entry) => entry.decisionAction?.completed && entry.decisionAction?.awaitingEditorAssignment
  ).length;
  const automaticallyApprovedRevisions = manuscripts.filter(
    (entry) => entry.assessment?.mode === "automatic-revision" && entry.assessment?.decision === "APPROVE"
  ).length;
  const llmAssessments = manuscripts
    .map((entry) => entry.assessment)
    .filter((assessment) => assessment?.provider === "codex-cli");
  const assessmentsWithUsage = llmAssessments.filter(
    (assessment) => assessment.usage?.available === true
  );
  const tokenUsage = {
    llmCalls: llmAssessments.length + assessmentErrors,
    callsWithUsage: assessmentsWithUsage.length,
    inputTokens: sumAssessmentUsage(assessmentsWithUsage, "inputTokens"),
    cachedInputTokens: sumAssessmentUsage(assessmentsWithUsage, "cachedInputTokens"),
    uncachedInputTokens: sumAssessmentUsage(assessmentsWithUsage, "uncachedInputTokens"),
    outputTokens: sumAssessmentUsage(assessmentsWithUsage, "outputTokens"),
    reasoningOutputTokens: sumAssessmentUsage(assessmentsWithUsage, "reasoningOutputTokens"),
    totalTokens: sumAssessmentUsage(assessmentsWithUsage, "totalTokens"),
  };
  tokenUsage.averageTotalTokensPerCall = tokenUsage.callsWithUsage
    ? Math.round(tokenUsage.totalTokens / tokenUsage.callsWithUsage)
    : 0;
  const totalAssessmentDurationMs = llmAssessments.reduce(
    (total, assessment) => total + (Number(assessment.durationMs) || 0),
    0
  );
  const limitReached = !scanAll && checked >= maxChecked;

  let status;
  if (manuscripts.length === 0) {
    status = "no_eligible_manuscript_found";
  } else if (assessmentErrors > 0 || actionErrors > 0) {
    status = "assessment_batch_completed_with_errors";
  } else if (applyAssessmentDecisions) {
    status = "assessment_live_actions_completed";
  } else {
    status = assessWithLlm ? "assessment_batch_completed" : "metadata_batch_collected";
  }

  const scopeNote = actionErrors > 0
    ? "Zatrzymano kolejkę po pierwszym niepotwierdzonym kroku live."
    : queueExhausted
      ? "Przejrzano całą dostępną kolejkę Complete Checklist."
      : limitReached
        ? `Zatrzymano po osiągnięciu limitu ${maxChecked} sprawdzonych manuskryptów.`
        : "Zakończono zbieranie dostępnych manuskryptów.";

  return {
    status,
    checked,
    eligibleCount: manuscripts.length,
    skippedUnusualActivity,
    manuscripts,
    summary: {
      checked,
      eligible: manuscripts.length,
      skippedUnusualActivity: skippedUnusualActivity.length,
      approved,
      rejected,
      automaticallyApprovedRevisions,
      assessmentErrors,
      liveApproved,
      liveRejected,
      liveApprovedAwaitingAssignment,
      actionErrors,
      totalAssessmentDurationMs,
      tokenUsage,
    },
    queueExhausted,
    limitReached,
    note: applyAssessmentDecisions
      ? `${scopeNote} Zastosowano decyzje w ScholarOne: APPROVE ${liveApproved}, REJECT ${liveRejected}.${
        liveApprovedAwaitingAssignment > 0
          ? ` ${liveApprovedAwaitingAssignment} zatwierdzonych czeka w Awaiting EIC Assignment na ręczne dobranie edytorów.`
          : ""
      }`
      : assessWithLlm
      ? `${scopeNote} Oceny LLM są wstępne i informacyjne; nie kliknięto Complete Checklist ani żadnej decyzji.`
      : `${scopeNote} Nie kliknięto Complete Checklist ani żadnej decyzji.`,
  };
}

function sumAssessmentUsage(assessments, key) {
  return assessments.reduce((total, assessment) => {
    const value = Number(assessment.usage?.[key]);
    return total + (Number.isFinite(value) && value >= 0 ? value : 0);
  }, 0);
}
