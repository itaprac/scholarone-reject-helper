import assert from "node:assert/strict";
import test from "node:test";
import { applyProgressLine, createProgressState, parseProgress } from "../src/job-progress.js";

// Panel pokazywał dotąd tylko surowy stdout. Te testy pilnują, że z tych samych
// linii da się odczytać stan przebiegu — inaczej pasek postępu pokazywałby
// wartości oderwane od tego, co naprawdę robi automat.

test("odczytuje numer i ID aktualnie sprawdzanego manuskryptu", () => {
  const state = parseProgress([
    "[1] KES-25-0001 -> tytuł: Pierwszy artykuł",
    "[2] KES-25-0002 -> tytuł: Drugi artykuł",
  ].join("\n"));

  assert.equal(state.checked, 2);
  assert.equal(state.currentManuscriptId, "KES-25-0002");
});

test("liczy decyzje modelu w obu wariantach linii wyniku", () => {
  const parallel = parseProgress([
    "[LLM RESULT] KES-25-0001 REJECT: poza zakresem",
    "[LLM RESULT] KES-25-0002 APPROVE: pasuje",
  ].join("\n"));
  assert.deepEqual(parallel.decisions, { REJECT: 1, APPROVE: 1 });

  // Tryb live wypisuje wynik bez ID.
  const sequential = parseProgress("[LLM RESULT] APPROVE: pasuje do profilu");
  assert.deepEqual(sequential.decisions, { APPROVE: 1 });
});

test("automatyczne zatwierdzenia rewizji są liczone osobno", () => {
  const state = parseProgress([
    "[AUTO APPROVE] KES-25-0001.R1: rewizja .R + liczba; pomijam abstrakt i LLM.",
    "[AUTO APPROVE] KES-25-0002.R2: rewizja .R + liczba; pomijam abstrakt i LLM.",
  ].join("\n"));

  assert.equal(state.automaticApprovals, 2);
  assert.equal(state.decisions.APPROVE, 2);
});

test("rozpoznaje wysłane odrzucenia i pomijane artykuły", () => {
  const state = parseProgress([
    "[3] KES-25-0003 -> sent: Reject email sent (1/4).",
    "[4] KES-25-0004 -> pominięty: czerwony alert unusual activity",
  ].join("\n"));

  assert.equal(state.sent, 1);
  assert.equal(state.lastSentManuscriptId, "KES-25-0003");
  assert.equal(state.skipped, 1);
});

test("śledzi licznik operacji nieodwracalnych razem z limitem", () => {
  const state = parseProgress("[LIVE ACTION COMPLETE] KES-25-0005: REJECT (7/25).");

  assert.equal(state.liveActions, 7);
  assert.equal(state.liveActionLimit, 25);
});

test("liczy błędy modelu i trafienia w cache", () => {
  const state = parseProgress([
    "[LLM ERROR] KES-25-0006: Codex CLI przekroczył limit 120 s.",
    "[LLM CACHE] wynik z 2026-07-20T10:00:00.000Z — bez ponownego wywołania modelu",
  ].join("\n"));

  assert.equal(state.errors, 1);
  assert.equal(state.cacheHits, 1);
});

test("zapamiętuje podsumowanie tokenów z końca przebiegu", () => {
  const state = parseProgress("[TOKEN SUMMARY] input=12000, output=3400, razem=15400");
  assert.equal(state.tokenSummary, "input=12000, output=3400, razem=15400");
});

test("linie spoza wzorców nie psują stanu", () => {
  const state = createProgressState();
  for (const line of ["", "   ", "Log: logs/2026-07-25.jsonl", "Reports: logs/reports"]) {
    applyProgressLine(state, line);
  }
  assert.deepEqual(state, createProgressState());
});

test("stan narasta przyrostowo, tak jak przy strumieniowaniu", () => {
  const state = createProgressState();
  applyProgressLine(state, "[1] KES-25-0001 -> tytuł: A");
  applyProgressLine(state, "[LLM RESULT] KES-25-0001 REJECT: powód");
  applyProgressLine(state, "[2] KES-25-0002 -> tytuł: B");

  assert.equal(state.checked, 2);
  assert.equal(state.currentManuscriptId, "KES-25-0002");
  assert.equal(state.decisions.REJECT, 1);
});
