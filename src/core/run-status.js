import fsp from "node:fs/promises";
import path from "node:path";

// Puls bieżącego przebiegu w logs/current-run.json. Plik JSONL opisuje pełną
// historię, ale nie mówi, czy proces nadal żyje ani który przebieg jest
// najnowszy — panel potrzebuje jednego pliku o stałej nazwie z PID-em.
// Zapis jest best-effort: awaria pulsu nie ma prawa przerwać przebiegu.
export function createRunStatus({ logsDir, runId, pid, mode, logFile }) {
  const statusPath = path.join(logsDir, "current-run.json");
  const now = new Date().toISOString();
  const status = {
    runId,
    pid,
    mode,
    status: "running",
    resultStatus: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    checked: 0,
    rejected: 0,
    // Liczniki przebiegu recenzentów: obrobione artykuły i wysłane zaproszenia.
    papersDone: 0,
    papersRequested: null,
    invited: 0,
    lastEvent: null,
    logFile,
  };

  async function write() {
    // Zapis przez rename, żeby czytelnik nigdy nie trafił na urwany JSON.
    const tmpPath = `${statusPath}.tmp`;
    await fsp.mkdir(logsDir, { recursive: true });
    await fsp.writeFile(tmpPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
    await fsp.rename(tmpPath, statusPath);
  }

  async function event(type, payload = {}) {
    try {
      const at = new Date().toISOString();
      status.updatedAt = at;
      status.lastEvent = compact({
        type,
        at,
        manuscriptId: payload.manuscriptId ?? payload.details?.manuscriptId,
        reason: payload.reason ?? payload.details?.reason,
        status: typeof payload.status === "string" ? payload.status : undefined,
        note: payload.note ?? payload.message,
      });

      // Liczniki pochodzą z różnych zdarzeń: rowIndex numeruje od zera,
      // checked/rejected pojawiają się w podsumowaniach.
      if (Number.isFinite(payload.checked)) {
        status.checked = Math.max(status.checked, payload.checked);
      }
      if (Number.isFinite(payload.rowIndex)) {
        status.checked = Math.max(status.checked, payload.rowIndex + 1);
      }
      if (Number.isFinite(payload.rejected)) {
        status.rejected = Math.max(status.rejected, payload.rejected);
      }

      // Przebieg recenzentów nie ma checked/rejected; jego postęp to artykuły
      // zamknięte w pętli batcha i faktycznie potwierdzone zaproszenia.
      if (
        ["batch_manuscript_finished", "deferred_reviewer_finished"].includes(type) &&
        payload.status !== "reviewer_search_deferred"
      ) {
        status.papersDone += 1;
      }
      if (Number.isFinite(payload.completed)) {
        status.papersDone = Math.max(status.papersDone, payload.completed);
      }
      if (Number.isFinite(payload.requested)) {
        status.papersRequested = payload.requested;
      }
      if (type === "invite_all_verification" && Number.isFinite(payload.invitedIncrease) && payload.invitedIncrease > 0) {
        status.invited += payload.invitedIncrease;
      }

      if (type === "run_finished") {
        status.status = "finished";
        status.resultStatus = typeof payload.status === "string" ? payload.status : null;
        status.finishedAt = at;
      } else if (type === "run_failed") {
        status.status = "failed";
        status.finishedAt = at;
      }

      await write();
    } catch {
      // Puls jest diagnostyką; przebieg działa dalej bez niego.
    }
  }

  return event;
}

function compact(entry) {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined && value !== null)
  );
}
