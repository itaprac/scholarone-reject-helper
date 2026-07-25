import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { QUEUE_CONTEXT_KEYS, setQueueContext } from "../src/steps/queue.js";
import { context, setRunContext } from "../src/workflows/context.js";

// Moduły kroków i workflow sięgają po zależności przebiegu przez obiekt
// kontekstu. Literówka w takim dostępie — np. ctx.ctx.ensureLoggedIn — nie jest
// dla lintera błędem, bo sam ctx istnieje; wychodzi dopiero w czasie działania,
// i to wyłącznie na rzadkiej ścieżce (ponowne logowanie po wylogowaniu przez
// ScholarOne). Ten test sprawdza takie odwołania statycznie.

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

const TARGETS = [
  { file: "steps/queue.js", object: "ctx", keys: QUEUE_CONTEXT_KEYS },
  { file: "workflows/screening.js", object: "context", keys: Object.keys(context) },
  { file: "workflows/reject-scan.js", object: "context", keys: Object.keys(context) },
  { file: "workflows/reject-from-report.js", object: "context", keys: Object.keys(context) },
];

for (const { file, object, keys } of TARGETS) {
  test(`${file}: każde ${object}.X wskazuje istniejące pole kontekstu`, () => {
    const source = fs.readFileSync(path.join(srcDir, file), "utf8");
    const unknown = new Set();

    for (const [, property] of source.matchAll(new RegExp(`\\b${object}\\.(\\w+)`, "g"))) {
      // "./context.js" w imporcie nie jest odwołaniem do pola.
      if (property === "js") continue;
      if (!keys.includes(property)) unknown.add(property);
    }

    assert.deepEqual(
      [...unknown],
      [],
      `nieznane pola kontekstu w ${file}: ${[...unknown].join(", ")}`
    );
  });

  test(`${file}: brak podwojonego prefiksu ${object}.${object}.`, () => {
    const source = fs.readFileSync(path.join(srcDir, file), "utf8");
    assert.equal(
      source.includes(`${object}.${object}.`),
      false,
      `${file} zawiera ${object}.${object}. — dostęp do pola na undefined`
    );
  });
}

test("setQueueContext odrzuca nieznany klucz zamiast przyjąć go po cichu", () => {
  assert.throws(
    () => setQueueContext({ ensureLogedIn: async () => false }),
    /nieznany klucz kontekstu/
  );
});

test("setQueueContext przyjmuje pełny, poprawny kontekst", () => {
  assert.doesNotThrow(() =>
    setQueueContext({
      config: {},
      log: async () => undefined,
      ensureLoggedIn: async () => false,
      screenshots: null,
    })
  );
});

test("kontekst przebiegu ma wszystkie pola, których używają workflow", () => {
  const wired = setRunContext({
    config: { maxRejected: 1 },
    runId: "test-run",
    reportDir: "/tmp",
    screenshots: null,
    log: async () => undefined,
    ensureLoggedIn: async () => false,
    quickSearchManuscript: async () => ({ found: false }),
  });

  for (const key of ["config", "runId", "reportDir", "screenshots", "log", "ensureLoggedIn", "quickSearchManuscript"]) {
    assert.ok(key in wired, `brak pola ${key} w kontekście przebiegu`);
  }
});
