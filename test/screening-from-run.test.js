import assert from "node:assert/strict";
import test from "node:test";
import { extractExecutableDecisions } from "../src/workflows/screening-from-run.js";
import { translateScreenArgs } from "../src/cli-commands.js";

// Wykonanie decyzji z zapisanego przebiegu jest operacją nieodwracalną, a jej
// wejściem jest plik sprzed godzin albo dni. Reguły wyboru, co wolno wykonać,
// są tu najważniejsze.

function run(manuscripts) {
  return { result: { manuscripts } };
}

test("bierze decyzje z oceną i bez błędu", () => {
  const decisions = extractExecutableDecisions(run([
    {
      metadata: { manuscriptId: "KES-25-0001" },
      assessment: { decision: "REJECT", reason: "poza zakresem" },
    },
    {
      metadata: { manuscriptId: "KES-25-0002" },
      assessment: { decision: "APPROVE", reason: "pasuje" },
    },
  ]));

  assert.deepEqual(decisions.map((d) => [d.manuscriptId, d.decision]), [
    ["KES-25-0001", "REJECT"],
    ["KES-25-0002", "APPROVE"],
  ]);
});

test("pomija artykuły, które w tamtym przebiegu już dostały akcję", () => {
  const decisions = extractExecutableDecisions(run([
    {
      metadata: { manuscriptId: "KES-25-0001" },
      assessment: { decision: "REJECT", reason: "powód" },
      // Przebieg live wykonał to już wtedy — powtórzenie wysłałoby drugi mail.
      decisionAction: { completed: true, decision: "REJECT" },
    },
    {
      metadata: { manuscriptId: "KES-25-0002" },
      assessment: { decision: "APPROVE", reason: "powód" },
    },
  ]));

  assert.deepEqual(decisions.map((d) => d.manuscriptId), ["KES-25-0002"]);
});

test("pomija artykuły, dla których ocena się nie udała", () => {
  const decisions = extractExecutableDecisions(run([
    {
      metadata: { manuscriptId: "KES-25-0003" },
      assessment: { decision: "REJECT", reason: "powód" },
      assessmentError: { message: "timeout" },
    },
    { metadata: { manuscriptId: "KES-25-0004" }, assessment: null },
    { metadata: { manuscriptId: "KES-25-0005" }, assessmentError: { message: "brak JSON" } },
  ]));

  assert.deepEqual(decisions, []);
});

test("pomija wpisy bez identyfikatora manuskryptu", () => {
  const decisions = extractExecutableDecisions(run([
    { metadata: {}, assessment: { decision: "REJECT", reason: "powód" } },
    { metadata: { manuscriptId: "   " }, assessment: { decision: "APPROVE", reason: "powód" } },
  ]));

  assert.deepEqual(decisions, []);
});

test("normalizuje identyfikatory tak samo jak reszta automatu", () => {
  const [decision] = extractExecutableDecisions(run([
    { metadata: { manuscriptId: "  kes-25-0006  " }, assessment: { decision: "APPROVE", reason: "ok" } },
  ]));

  assert.equal(decision.manuscriptId, "KES-25-0006");
});

test("pusty albo uszkodzony plik nie daje niczego do wykonania", () => {
  assert.deepEqual(extractExecutableDecisions(null), []);
  assert.deepEqual(extractExecutableDecisions({}), []);
  assert.deepEqual(extractExecutableDecisions({ result: {} }), []);
  assert.deepEqual(extractExecutableDecisions(run([])), []);
});

test("screen --from-run nie zbiera metadanych i nie pyta modelu", () => {
  const args = translateScreenArgs(["--from-run=logs/screening/a.json"]);

  assert.ok(args.includes("--from-run=logs/screening/a.json"));
  assert.equal(args.includes("--collect-metadata"), false);
  assert.equal(args.includes("--assess-with-llm"), false);
  assert.equal(args.includes("--apply-assessment-decisions"), false);
});

test("zwykły screen --live nie zmienia zachowania", () => {
  const args = translateScreenArgs(["--live"]);

  assert.ok(args.includes("--collect-metadata"));
  assert.ok(args.includes("--assess-with-llm"));
  assert.ok(args.includes("--apply-assessment-decisions"));
  assert.equal(args.some((arg) => arg.startsWith("--from-run=")), false);
});
