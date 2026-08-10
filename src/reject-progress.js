// Plik postępu obok raportu. Dzięki niemu ponowne uruchomienie
// reject-from-report pomija manuskrypty już obsłużone, zamiast wysyłać maila
// drugi raz.
import fsp from "node:fs/promises";
import path from "node:path";
import { extractCandidateIdsFromCsv, extractCandidateIdsFromJson } from "./reporting/csv.js";
import { simpleHash } from "./reporting/report.js";
import { normalizeManuscriptId } from "./manuscript-rules.js";
import { resolveProjectPath } from "./core/env.js";

export async function loadRejectTargets(config) {
  const ids = [...config.rejectIds];

  if (config.rejectFromReport) {
    const absolutePath = path.isAbsolute(config.rejectFromReport)
      ? config.rejectFromReport
      : resolveProjectPath(config.rejectFromReport);
    const content = await fsp.readFile(absolutePath, "utf8");

    if (/\.csv$/i.test(absolutePath)) {
      ids.push(...extractCandidateIdsFromCsv(content));
    } else {
      ids.push(...extractCandidateIdsFromJson(JSON.parse(content)));
    }
  }

  return Array.from(new Set(ids.map(normalizeManuscriptId).filter(Boolean)));
}

export function getRejectProgressPath(targets, config, reportDir) {
  if (config.rejectProgressFile) {
    return path.isAbsolute(config.rejectProgressFile)
      ? config.rejectProgressFile
      : resolveProjectPath(config.rejectProgressFile);
  }

  if (config.rejectFromReport) {
    const reportPath = path.isAbsolute(config.rejectFromReport)
      ? config.rejectFromReport
      : resolveProjectPath(config.rejectFromReport);
    return reportPath.replace(/\.(json|csv)$/i, ".progress.json");
  }

  const hash = simpleHash(targets.join(","));
  return path.join(reportDir, `manual-targets-${hash}.progress.json`);
}

export async function loadRejectProgress(progressPath, targets, config = {}) {
  try {
    const content = await fsp.readFile(progressPath, "utf8");
    const progress = JSON.parse(content);
    progress.manuscripts ||= {};
    return progress;
  } catch {
    return {
      createdAt: new Date().toISOString(),
      updatedAt: null,
      sourceReport: config.rejectFromReport || null,
      targetCount: targets.length,
      manuscripts: {},
    };
  }
}

export function getRejectProgressEntry(progress, manuscriptId) {
  return progress.manuscripts[normalizeManuscriptId(manuscriptId)] || null;
}

export function isTerminalRejectProgress(status) {
  return [
    "sent",
    "not_actionable_no_reject_control",
  ].includes(status);
}

export async function markRejectProgress(progress, progressPath, manuscriptId, entry, config = {}) {
  const key = normalizeManuscriptId(manuscriptId);
  progress.updatedAt = new Date().toISOString();
  progress.sourceReport = config.rejectFromReport || progress.sourceReport || null;
  progress.manuscripts[key] = {
    manuscriptId: key,
    ...entry,
  };

  await fsp.mkdir(path.dirname(progressPath), { recursive: true });
  await fsp.writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
}
