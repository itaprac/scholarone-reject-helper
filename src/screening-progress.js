import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeManuscriptId } from "./manuscript-rules.js";

// Plik postępu screeningu live.
//
// Odrzucanie z raportu miało *.progress.json i po restarcie pomijało obsłużone
// manuskrypty. Screening live nie miał nic równoważnego: zatrzymywał całą
// kolejkę na pierwszym niepotwierdzonym kroku, a ponowne uruchomienie ruszało
// od zera i mogło powtórzyć akcję na artykule, który już ją dostał.
//
// Wpis powstaje PRZED akcją ze stanem "attempted" i dopiero potwierdzenie
// przestawia go na terminalny. Dzięki temu przerwanie w trakcie zostawia ślad,
// który przy wznowieniu wymaga ręcznego sprawdzenia zamiast cichej powtórki.
const TERMINAL_STATUSES = new Set(["approved", "rejected", "skipped"]);

export function screeningProgressPath(logsDir, key = "live") {
  return path.join(logsDir, "screening", `${key}.progress.json`);
}

export async function loadScreeningProgress(progressPath) {
  try {
    const progress = JSON.parse(await fsp.readFile(progressPath, "utf8"));
    progress.manuscripts ||= {};
    return progress;
  } catch {
    return {
      createdAt: new Date().toISOString(),
      updatedAt: null,
      manuscripts: {},
    };
  }
}

export function screeningProgressEntry(progress, manuscriptId) {
  return progress.manuscripts[normalizeManuscriptId(manuscriptId)] || null;
}

export function isTerminalScreeningStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

// Manuskrypt jest do pominięcia tylko po potwierdzonej akcji. Wpis "attempted"
// oznacza przerwanie w połowie — automat nie ma prawa zgadywać, czy wiadomość
// wyszła, więc zgłasza to do ręcznego sprawdzenia.
export function screeningResumeDecision(progress, manuscriptId) {
  const entry = screeningProgressEntry(progress, manuscriptId);
  if (!entry) return { action: "process" };
  if (isTerminalScreeningStatus(entry.status)) {
    return { action: "skip", reason: entry.status, at: entry.at };
  }
  if (entry.status === "attempted") {
    return {
      action: "needs_manual_check",
      reason: `Poprzedni przebieg zaczął akcję ${entry.decision || "?"} i jej nie potwierdził.`,
      at: entry.at,
    };
  }
  return { action: "process" };
}

export async function markScreeningProgress(progress, progressPath, manuscriptId, entry) {
  const key = normalizeManuscriptId(manuscriptId);
  progress.updatedAt = new Date().toISOString();
  progress.manuscripts[key] = {
    manuscriptId: key,
    at: progress.updatedAt,
    ...entry,
  };

  await fsp.mkdir(path.dirname(progressPath), { recursive: true });
  await fsp.writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
  return progress.manuscripts[key];
}
