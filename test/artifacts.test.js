import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanArity } from "../scripts/check-arity.mjs";
import {
  publicConfigSnapshot,
  writeMetadataArtifact,
  writeRunArtifacts,
} from "../src/reporting/artifacts.js";

// Zapis raportu wykonuje się na samym końcu przebiegu, więc błąd w tej warstwie
// przewraca run po wysłaniu wszystkich maili — praca jest zrobiona, ale raportu
// nie ma. Dlatego jest testowany osobno, bez uruchamiania przeglądarki.

function sampleConfig(overrides = {}) {
  return {
    startUrl: "https://mc.manuscriptcentral.com/kes",
    maxChecked: 50,
    submittedOlderThanDays: 30,
    headless: false,
    browserChannel: "",
    cdp: "",
    slowMo: 500,
    dryRun: false,
    reportOnly: false,
    clickReject: true,
    saveAndSend: true,
    maxRejected: 4,
    queueStartPage: 0,
    rejectFromReport: "",
    rejectIds: [],
    rejectProgressFile: "",
    requireTargets: false,
    autoLogin: true,
    loginUsername: "user",
    loginPassword: "secret",
    logsDir: "/tmp",
    assessWithLlm: true,
    scanAllMetadata: true,
    assessmentModel: "gpt-test",
    assessmentReasoningEffort: "medium",
    assessmentTimeoutSeconds: 120,
    assessmentPrompt: "prompt oceny",
    applyAssessmentDecisions: false,
    screeningEditorName: "Testowy, Edytor",
    screeningRejectMessage: "wiadomość",
    ...overrides,
  };
}

test("zapisuje raport JSON i CSV przebiegu odrzucania", async () => {
  const reportDir = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-report-"));
  const result = {
    status: "search_reject_finished",
    checked: 2,
    report: { candidates: [], decisions: [] },
  };

  const artifacts = await writeRunArtifacts(result, {
    config: sampleConfig(),
    runId: "2026-07-25T22-00-00-000Z",
    reportDir,
  });

  const payload = JSON.parse(await fsp.readFile(artifacts.json, "utf8"));
  assert.equal(payload.runId, "2026-07-25T22-00-00-000Z");
  assert.equal(payload.result.checked, 2);
  assert.equal(payload.config.startUrl, "https://mc.manuscriptcentral.com/kes");
  assert.ok(await fsp.readFile(artifacts.csv, "utf8"));
});

test("migawka konfiguracji nie zawiera hasła", () => {
  const snapshot = publicConfigSnapshot(sampleConfig());

  assert.equal(snapshot.hasLoginCredentials, true);
  assert.equal(snapshot.loginPassword, undefined, "hasło nie ma prawa trafić do raportu");
  assert.equal(snapshot.loginUsername, undefined);
  assert.equal(snapshot.browserChannel, "playwright-chromium", "pusty kanał opisany wprost");
  assert.equal(snapshot.cdp, null);
});

test("migawka wymaga konfiguracji i mówi o tym wprost", () => {
  // Wywołanie bez argumentu było realnym błędem: przebieg wysyłał maile,
  // a wywracał się dopiero przy zapisie raportu.
  assert.throws(() => publicConfigSnapshot(), TypeError);
});

test("zapisuje wynik screeningu razem z CSV", async () => {
  const logsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-screening-"));
  const result = {
    status: "metadata_finished",
    checked: 1,
    manuscripts: [{
      metadata: { manuscriptId: "KES-25-0001", title: "Tytuł", abstract: "Abstrakt" },
      assessment: { decision: "REJECT", reason: "powód", usage: { available: false } },
    }],
    skippedUnusualActivity: [],
    summary: { checked: 1, tokenUsage: {} },
  };

  const artifactPath = await writeMetadataArtifact(result, {
    config: sampleConfig({ logsDir }),
    runId: "2026-07-25T22-10-00-000Z",
  });

  const payload = JSON.parse(await fsp.readFile(artifactPath, "utf8"));
  assert.equal(payload.result.manuscripts.length, 1);
  assert.equal(payload.config.assessmentPromptLength, "prompt oceny".length);
  assert.equal(payload.config.assessmentPrompt, undefined, "prompt zapisujemy tylko jako długość");
  assert.ok(await fsp.readFile(result.summaryCsv, "utf8"));
});

// Powyższe błędy — brakujący argument po zmianie sygnatury — są niewidoczne dla
// lintera, bo funkcja istnieje. Ten test skanuje całe src statycznie.
test("żadna funkcja w src nie jest wołana ze zbyt małą liczbą argumentów", () => {
  const problems = scanArity(["src"]);
  const described = problems.map(
    (problem) => `${problem.file}:${problem.line} ${problem.name}(${problem.given}) wymaga ${problem.required}`
  );
  assert.deepEqual(described, []);
});
