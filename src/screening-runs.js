import fsp from "node:fs/promises";
import path from "node:path";

// Odczyt wyników screeningu dla panelu.
//
// Karta Initial assessment potrafiła dotąd odpalić przebieg, ale nie pokazać,
// co z niego wyszło — wyniki były wyłącznie w logs/screening/*-summary.csv.
// Żeby cokolwiek zobaczyć, trzeba było wyjść z panelu i otworzyć plik.
const RUN_FILE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/;

export async function listScreeningRuns(logsDir, { limit = 20 } = {}) {
  const directory = path.join(logsDir, "screening");
  const files = (await fsp.readdir(directory).catch(() => []))
    .filter((name) => RUN_FILE.test(name));

  const runs = [];
  for (const filename of files) {
    const payload = await readJson(path.join(directory, filename));
    const result = payload?.result;
    if (!result) continue;

    runs.push({
      filename,
      runId: payload.runId || filename.replace(/\.json$/, ""),
      createdAt: payload.createdAt || null,
      status: result.status || "",
      live: Boolean(payload.config?.applyAssessmentDecisions),
      summary: result.summary || null,
      manuscriptCount: (result.manuscripts || []).length,
    });
  }

  return runs
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, limit);
}

export async function readScreeningRun(logsDir, filename) {
  if (!RUN_FILE.test(filename)) {
    const error = new Error("Nieprawidłowa nazwa pliku wyniku screeningu.");
    error.statusCode = 400;
    throw error;
  }

  const payload = await readJson(path.join(logsDir, "screening", filename));
  if (!payload?.result) {
    const error = new Error("Nie znaleziono wyniku screeningu.");
    error.statusCode = 404;
    throw error;
  }

  return {
    runId: payload.runId,
    createdAt: payload.createdAt,
    live: Boolean(payload.config?.applyAssessmentDecisions),
    summary: payload.result.summary || null,
    manuscripts: (payload.result.manuscripts || []).map(toRow),
    skipped: payload.result.skippedUnusualActivity || [],
  };
}

// Spłaszczenie zagnieżdżonego wpisu do jednego wiersza tabeli.
function toRow(entry) {
  const metadata = entry.metadata || {};
  const assessment = entry.assessment || null;

  return {
    manuscriptId: metadata.manuscriptId || null,
    title: metadata.title || "",
    abstract: metadata.abstract || "",
    decision: assessment?.decision || null,
    reason: assessment?.reason || "",
    mode: assessment?.mode || null,
    cached: Boolean(assessment?.cached),
    durationMs: assessment?.durationMs ?? null,
    totalTokens: assessment?.usage?.totalTokens ?? null,
    // Rozdzielamy błąd oceny od błędu akcji: pierwszy znaczy "nie wiemy, co
    // zrobić", drugi "wiedzieliśmy, ale nie udało się wykonać".
    assessmentError: entry.assessmentError?.message || null,
    actionError: entry.actionError?.message || null,
    actionCompleted: Boolean(entry.decisionAction?.completed),
    actionDecision: entry.decisionAction?.decision || null,
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}
