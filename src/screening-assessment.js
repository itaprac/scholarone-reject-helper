import { isRevisionManuscriptId, normalizeManuscriptId } from "./manuscript-rules.js";

export const AUTOMATIC_REVISION_MODE = "automatic-revision";

export function classifyScreeningManuscript(manuscriptId, { hasUnusualActivity = false } = {}) {
  if (isRevisionManuscriptId(manuscriptId)) {
    return "automatic-revision-approve";
  }
  if (hasUnusualActivity) {
    return "skip-unusual-activity";
  }
  return "assess";
}

export function buildAutomaticRevisionAssessment(manuscriptId) {
  const normalizedId = normalizeManuscriptId(manuscriptId);
  if (!isRevisionManuscriptId(normalizedId)) {
    throw new Error(`Automatyczne APPROVE wymaga identyfikatora rewizji .R + liczba: ${manuscriptId || "brak"}`);
  }

  return {
    provider: "rule",
    model: null,
    reasoningEffort: null,
    mode: AUTOMATIC_REVISION_MODE,
    decision: "APPROVE",
    reason: `Automatyczne APPROVE: ${normalizedId} jest rewizją (.R + liczba).`,
    durationMs: 0,
    outputPath: null,
    eventsPath: null,
    usage: null,
  };
}
