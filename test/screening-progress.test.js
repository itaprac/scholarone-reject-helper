import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isTerminalScreeningStatus,
  loadScreeningProgress,
  markScreeningProgress,
  screeningResumeDecision,
} from "../src/screening-progress.js";
import { createLiveGuard, isLiveActionLimit } from "../src/core/live-guard.js";
import { createActionLog } from "../src/core/action-log.js";

test("nieznany manuskrypt jest przetwarzany normalnie", async () => {
  const progress = await loadScreeningProgress(path.join(os.tmpdir(), "brak.json"));
  assert.deepEqual(screeningResumeDecision(progress, "KES-25-0001"), { action: "process" });
});

test("potwierdzona akcja pomija manuskrypt przy wznowieniu", async () => {
  const { progress, progressPath } = await freshProgress();
  await markScreeningProgress(progress, progressPath, "KES-25-0001", {
    status: "rejected",
    decision: "REJECT",
  });

  const decision = screeningResumeDecision(progress, "KES-25-0001");
  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "rejected");
});

test("przerwana akcja trafia do ręcznego sprawdzenia, a nie do powtórki", async () => {
  const { progress, progressPath } = await freshProgress();
  // Wpis zapisany tuż przed kliknięciem Save and Send; przebieg przerwano.
  await markScreeningProgress(progress, progressPath, "KES-25-0002", {
    status: "attempted",
    decision: "REJECT",
  });

  const decision = screeningResumeDecision(progress, "KES-25-0002");
  assert.equal(decision.action, "needs_manual_check");
  assert.match(decision.reason, /nie potwierdził/);
});

test("postęp przeżywa ponowny odczyt z dysku", async () => {
  const { progress, progressPath } = await freshProgress();
  await markScreeningProgress(progress, progressPath, "KES-25-0003", { status: "approved" });

  const reloaded = await loadScreeningProgress(progressPath);
  assert.equal(screeningResumeDecision(reloaded, "KES-25-0003").action, "skip");
});

test("normalizacja ID działa niezależnie od zapisu", async () => {
  const { progress, progressPath } = await freshProgress();
  await markScreeningProgress(progress, progressPath, "  kes-25-0004  ", { status: "approved" });
  assert.equal(screeningResumeDecision(progress, "KES-25-0004").action, "skip");
});

test("statusy terminalne są rozpoznawane", () => {
  assert.equal(isTerminalScreeningStatus("approved"), true);
  assert.equal(isTerminalScreeningStatus("rejected"), true);
  assert.equal(isTerminalScreeningStatus("skipped"), true);
  assert.equal(isTerminalScreeningStatus("attempted"), false);
  assert.equal(isTerminalScreeningStatus("failed"), false);
});

test("bezpiecznik zatrzymuje przebieg przed przekroczeniem limitu", () => {
  const guard = createLiveGuard({ limit: 2 });

  guard.assertCanProceed("reject");
  guard.recordPerformed();
  guard.assertCanProceed("reject");
  guard.recordPerformed();

  assert.equal(guard.remaining, 0);
  assert.throws(() => guard.assertCanProceed("reject"), (error) => {
    assert.ok(isLiveActionLimit(error));
    assert.match(error.message, /limit 2/);
    return true;
  });
});

test("limit sprawdzany jest przed akcją, nie po niej", () => {
  const guard = createLiveGuard({ limit: 1 });
  guard.assertCanProceed("invite");
  guard.recordPerformed();

  // Gdyby limit sprawdzano po akcji, druga wysyłka już by wyszła.
  assert.throws(() => guard.assertCanProceed("invite"), isLiveActionLimit);
  assert.equal(guard.performed, 1, "druga akcja nie została policzona, bo się nie odbyła");
});

test("brak limitu nie ogranicza przebiegu", () => {
  const guard = createLiveGuard({});
  for (let i = 0; i < 50; i++) {
    guard.assertCanProceed("reject");
    guard.recordPerformed();
  }
  assert.equal(guard.performed, 50);
  assert.equal(guard.describe(), "50");
});

test("dziennik akcji odpowiada, czy artykuł dostał już wiadomość", async () => {
  const logsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-actions-"));
  const log = createActionLog(logsDir);

  await log.record({ runId: "r1", mode: "screening-live", manuscriptId: "KES-25-0010", action: "reject-email", outcome: "sent", confirmed: true });
  await log.record({ runId: "r1", mode: "screening-live", manuscriptId: "KES-25-0011", action: "reject-email", outcome: "failed", confirmed: false });

  assert.equal(await log.wasCompleted("KES-25-0010", "reject-email"), true);
  assert.equal(await log.wasCompleted("KES-25-0011", "reject-email"), false, "nieudana wysyłka to nie wysłana wiadomość");
  assert.equal(await log.wasCompleted("KES-25-0012", "reject-email"), false);
  assert.equal((await log.readAll()).length, 2);
});

test("dziennik akcji jest dopisywalny między przebiegami", async () => {
  const logsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-actions-"));

  await createActionLog(logsDir).record({ runId: "r1", mode: "reject", manuscriptId: "A", action: "reject-email", outcome: "sent", confirmed: true });
  await createActionLog(logsDir).record({ runId: "r2", mode: "reject", manuscriptId: "B", action: "reject-email", outcome: "sent", confirmed: true });

  const entries = await createActionLog(logsDir).readAll();
  assert.deepEqual(entries.map((entry) => entry.manuscriptId), ["A", "B"]);
  assert.deepEqual(entries.map((entry) => entry.runId), ["r1", "r2"]);
});

async function freshProgress() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-progress-"));
  const progressPath = path.join(dir, "live.progress.json");
  return { progress: await loadScreeningProgress(progressPath), progressPath };
}
