import assert from "node:assert/strict";
import test from "node:test";
import {
  translateRejectArgs,
  translateReviewerArgs,
  translateScreenArgs,
} from "../src/cli-commands.js";

// Komendy są warstwą nad istniejącymi flagami. Najważniejsze, żeby domyślny
// wariant każdej z nich był tym bezpiecznym — realna wysyłka musi wymagać
// jawnego przełącznika.

test("reject bez przełącznika jest dry-runem", () => {
  const args = translateRejectArgs([]);
  assert.ok(args.includes("--dry-run"));
  assert.equal(args.includes("--save-and-send"), false);
});

test("reject --send włącza realną wysyłkę", () => {
  const args = translateRejectArgs(["--send"]);
  assert.ok(args.includes("--save-and-send"));
  assert.equal(args.includes("--dry-run"), false);
});

test("reject --from-report wymusza tryb z listą celów", () => {
  const args = translateRejectArgs(["--send", "--from-report=logs/reports/a.json"]);
  assert.ok(args.includes("--require-targets"));
  assert.ok(args.includes("--reject-from-report=logs/reports/a.json"));
});

test("stara flaga --reject-from-report też wymusza listę celów", () => {
  // Bez tego npm run reject:from-report zsunąłby się do przejścia całej kolejki.
  const args = translateRejectArgs(["--send", "--reject-from-report=logs/reports/a.json"]);
  assert.ok(args.includes("--require-targets"));
  assert.ok(args.includes("--reject-from-report=logs/reports/a.json"));
});

test("--reject-ids też jest listą celów", () => {
  assert.ok(translateRejectArgs(["--send", "--reject-ids=KES-25-0001"]).includes("--require-targets"));
});

test("screen bez przełącznika nie wykonuje decyzji", () => {
  const args = translateScreenArgs([]);
  assert.ok(args.includes("--collect-metadata"));
  assert.ok(args.includes("--assess-with-llm"));
  assert.equal(args.includes("--apply-assessment-decisions"), false);
});

test("screen --live wykonuje decyzje i nie przechodzi całej kolejki", () => {
  const args = translateScreenArgs(["--live"]);
  assert.ok(args.includes("--apply-assessment-decisions"));
  assert.equal(args.includes("--scan-all-metadata"), false);
});

test("reviewers --prepare nie wysyła zaproszeń", () => {
  const args = translateReviewerArgs(["--prepare"]);
  assert.ok(args.includes("--select-reviewers"));
  assert.equal(args.includes("--invite-all"), false);
});

test("reviewers --invite jest jedynym wariantem wysyłającym", () => {
  const args = translateReviewerArgs(["--invite"]);
  assert.ok(args.includes("--invite-all"));
});

test("nieznane flagi przechodzą dalej bez zmian", () => {
  assert.ok(translateRejectArgs(["--send", "--slow-mo=800", "--keep-open"]).includes("--slow-mo=800"));
  assert.ok(translateRejectArgs(["--send", "--keep-open"]).includes("--keep-open"));
  assert.ok(translateScreenArgs(["--live", "--max-checked=3"]).includes("--max-checked=3"));
  assert.ok(translateReviewerArgs(["--invite", "--reviewers-per-paper=8"]).includes("--reviewers-per-paper=8"));
});

test("przełączniki komendy nie wyciekają do argumentów automatu", () => {
  for (const args of [
    translateRejectArgs(["--send", "--from-report=x.json"]),
    translateScreenArgs(["--live"]),
    translateReviewerArgs(["--invite", "--queue=combined"]),
  ]) {
    for (const leaked of ["--send", "--live", "--invite", "--prepare"]) {
      assert.equal(args.includes(leaked), false, `${leaked} nie powinno trafić dalej`);
    }
    assert.equal(args.some((arg) => arg.startsWith("--queue=")), false);
    assert.equal(args.some((arg) => arg.startsWith("--from-report=")), false);
  }
});
