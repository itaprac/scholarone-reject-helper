import assert from "node:assert/strict";
import test from "node:test";

// Zanim auto-reject.js został rozbity, cała logika wykonywała się przy imporcie,
// więc żadnego z tych modułów nie dało się załadować bez uruchomienia
// przeglądarki. Ten test pilnuje, żeby tak nie wróciło — i przy okazji łapie
// literówki w importach, których nie widzi żaden inny test.
const MODULES = [
  "../src/run-reject.js",
  "../src/config/run-config.js",
  "../src/config/defaults.js",
  "../src/workflows/context.js",
  "../src/workflows/screening.js",
  "../src/workflows/reject-scan.js",
  "../src/workflows/reject-from-report.js",
  "../src/steps/queue.js",
  "../src/steps/checklist.js",
  "../src/steps/reject-email.js",
  "../src/steps/search.js",
  "../src/reporting/report.js",
  "../src/reporting/csv.js",
  "../src/reporting/artifacts.js",
  "../src/reject-progress.js",
  "../src/selectors/reject.js",
  "../src/core/browser.js",
  "../src/core/dom.js",
  "../src/core/env.js",
  "../src/core/login.js",
  "../src/core/logger.js",
  "../src/core/navigation.js",
  "../src/core/screenshots.js",
  "../src/core/timeouts.js",
  "../src/core/log-retention.js",
];

for (const specifier of MODULES) {
  test(`${specifier} importuje się bez efektów ubocznych`, async () => {
    const module = await import(specifier);
    assert.ok(module, `${specifier} nie zwrócił modułu`);
  });
}

test("workflow są eksportowanymi funkcjami, nie kodem wykonywanym przy imporcie", async () => {
  const { runScan } = await import("../src/workflows/reject-scan.js");
  const { runRejectTargetsFromSearch } = await import("../src/workflows/reject-from-report.js");
  const { runMetadataCollection } = await import("../src/workflows/screening.js");

  for (const workflow of [runScan, runRejectTargetsFromSearch, runMetadataCollection]) {
    assert.equal(typeof workflow, "function");
    assert.equal(workflow.length, 1, "workflow przyjmuje stronę Playwrighta");
  }
});
