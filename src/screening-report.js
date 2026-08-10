const SCREENING_CSV_HEADERS = [
  "runId",
  "index",
  "manuscriptId",
  "title",
  "abstract",
  "decision",
  "reason",
  "provider",
  "model",
  "reasoningEffort",
  "assessmentMode",
  "durationMs",
  "inputTokens",
  "cachedInputTokens",
  "uncachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "continuation",
  "liveAction",
  "assessmentError",
  "actionError",
  "screenshot",
  "llmOutputPath",
  "llmEventsPath",
];

export function screeningResultToCsv(result, runId) {
  const lines = [SCREENING_CSV_HEADERS.join(",")];
  for (const [index, entry] of (result.manuscripts || []).entries()) {
    const assessment = entry.assessment || {};
    const usage = assessment.usage || {};
    const row = {
      runId,
      index: index + 1,
      manuscriptId: entry.metadata?.manuscriptId || "",
      title: entry.metadata?.title || "",
      abstract: entry.metadata?.abstract || "",
      decision: assessment.decision || "",
      reason: assessment.reason || "",
      provider: assessment.provider || "",
      model: assessment.model || "",
      reasoningEffort: assessment.reasoningEffort || "",
      assessmentMode: assessment.mode || "",
      durationMs: assessment.durationMs ?? "",
      inputTokens: tokenCell(usage, "inputTokens"),
      cachedInputTokens: tokenCell(usage, "cachedInputTokens"),
      uncachedInputTokens: tokenCell(usage, "uncachedInputTokens"),
      outputTokens: tokenCell(usage, "outputTokens"),
      reasoningOutputTokens: tokenCell(usage, "reasoningOutputTokens"),
      totalTokens: tokenCell(usage, "totalTokens"),
      continuation: entry.continuation?.action || "",
      liveAction: entry.decisionAction?.completed
        ? entry.decisionAction.decision || "COMPLETED"
        : "",
      assessmentError: entry.assessmentError?.message || "",
      actionError: entry.actionError?.message || "",
      screenshot: entry.screenshot || "",
      llmOutputPath: assessment.outputPath || entry.assessmentError?.outputPath || "",
      llmEventsPath: assessment.eventsPath || entry.assessmentError?.eventsPath || "",
    };
    lines.push(SCREENING_CSV_HEADERS.map((header) => csvCell(row[header])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function formatTokenUsage(usage) {
  if (!usage || usage.callsWithUsage === 0) {
    return "brak danych o tokenach";
  }
  return [
    `wywołania=${usage.llmCalls}`,
    `input=${usage.inputTokens}`,
    `cache=${usage.cachedInputTokens}`,
    `output=${usage.outputTokens}`,
    `reasoning=${usage.reasoningOutputTokens}`,
    `razem=${usage.totalTokens}`,
  ].join(", ");
}

function tokenCell(usage, key) {
  return usage.available === true ? usage[key] ?? 0 : "";
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
