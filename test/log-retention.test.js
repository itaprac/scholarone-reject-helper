import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatBytes, pruneLogs } from "../src/core/log-retention.js";

const DAY = 24 * 60 * 60 * 1000;

test("zostawia najnowsze przebiegi i kasuje ogon razem ze zrzutami", async () => {
  const logsDir = await makeLogsDir();

  for (let index = 0; index < 6; index++) {
    const runId = `2026-07-0${index + 1}T10-00-00-000Z`;
    await writeRun(logsDir, runId, { ageDays: 60 - index });
  }

  const result = await pruneLogs({
    logsDir,
    keepRuns: 2,
    keepScreenshotRuns: 2,
    maxAgeDays: 30,
  });

  const remainingLogs = (await fsp.readdir(logsDir)).filter((name) => name.endsWith(".jsonl"));
  const remainingShots = await fsp.readdir(path.join(logsDir, "screenshots"));

  assert.deepEqual(remainingLogs.sort(), [
    "2026-07-05T10-00-00-000Z.jsonl",
    "2026-07-06T10-00-00-000Z.jsonl",
  ]);
  assert.deepEqual(remainingShots.sort(), [
    "2026-07-05T10-00-00-000Z",
    "2026-07-06T10-00-00-000Z",
  ]);
  assert.equal(result.removed.length, 8);
  assert.ok(result.freedBytes > 0);
});

test("zrzuty mają ciaśniejszy próg niż logi tekstowe i ignorują limit wieku", async () => {
  const logsDir = await makeLogsDir();

  for (let index = 0; index < 4; index++) {
    // Use distinct timestamps. Fast writes can share the same millisecond.
    await writeRun(logsDir, `2026-07-0${index + 1}T10-00-00-000Z`, { ageDays: 4 - index });
  }

  await pruneLogs({ logsDir, keepRuns: 10, keepScreenshotRuns: 1, maxAgeDays: 30 });

  const remainingLogs = (await fsp.readdir(logsDir)).filter((name) => name.endsWith(".jsonl"));
  const remainingShots = await fsp.readdir(path.join(logsDir, "screenshots"));

  assert.equal(remainingLogs.length, 4, "świeże logi tekstowe zostają");
  assert.deepEqual(remainingShots, ["2026-07-04T10-00-00-000Z"], "zrzuty tnie sam keepScreenshotRuns");
});

test("limit wieku chroni świeży ogon poza podłogą keepRuns", async () => {
  const logsDir = await makeLogsDir();

  await writeRun(logsDir, "2026-07-01T10-00-00-000Z", { ageDays: 1 });
  await writeRun(logsDir, "2026-07-02T10-00-00-000Z", { ageDays: 2 });
  await writeRun(logsDir, "2026-07-03T10-00-00-000Z", { ageDays: 3 });

  await pruneLogs({ logsDir, keepRuns: 1, maxAgeDays: 30 });

  const remaining = (await fsp.readdir(logsDir)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(remaining.length, 3, "nic młodszego niż 30 dni nie powinno zniknąć");
});

test("maxAgeDays=0 zostawia dokładnie keepRuns ostatnich przebiegów", async () => {
  const logsDir = await makeLogsDir();

  await writeRun(logsDir, "2026-07-01T10-00-00-000Z", { ageDays: 1 });
  await writeRun(logsDir, "2026-07-02T10-00-00-000Z", { ageDays: 2 });
  await writeRun(logsDir, "2026-07-03T10-00-00-000Z", { ageDays: 3 });

  await pruneLogs({ logsDir, keepRuns: 1, maxAgeDays: 0 });

  const remaining = (await fsp.readdir(logsDir)).filter((name) => name.endsWith(".jsonl"));
  assert.deepEqual(remaining, ["2026-07-01T10-00-00-000Z.jsonl"]);
});

test("raporty i wyniki screeningu przeżywają domyślne czyszczenie", async () => {
  const logsDir = await makeLogsDir();
  const reportsDir = path.join(logsDir, "reports");
  const screeningDir = path.join(logsDir, "screening");
  const eicAssessmentDir = path.join(logsDir, "eic-assessment");
  await fsp.mkdir(reportsDir, { recursive: true });
  await fsp.mkdir(screeningDir, { recursive: true });
  await fsp.mkdir(eicAssessmentDir, { recursive: true });

  const oldReport = path.join(reportsDir, "2026-01-01T10-00-00-000Z.json");
  const oldScreening = path.join(screeningDir, "2026-01-01T10-00-00-000Z.json");
  const oldEicAssessment = path.join(eicAssessmentDir, "2026-01-01T10-00-00-000Z.json");
  await fsp.writeFile(oldReport, "{}", "utf8");
  await fsp.writeFile(oldScreening, "{}", "utf8");
  await fsp.writeFile(oldEicAssessment, "{}", "utf8");
  await age(oldReport, 400);
  await age(oldScreening, 400);
  await age(oldEicAssessment, 400);

  await pruneLogs({ logsDir, keepRuns: 0, maxAgeDays: 1 });
  assert.ok(await exists(oldReport), "raport nie jest logiem debugowym");
  assert.ok(await exists(oldScreening), "wynik screeningu nie jest logiem debugowym");
  assert.ok(await exists(oldEicAssessment), "wynik EIC assessment nie jest logiem debugowym");

  await pruneLogs({ logsDir, keepRuns: 0, maxAgeDays: 1, includeReports: true, includeScreening: true });
  assert.equal(await exists(oldReport), false);
  assert.equal(await exists(oldScreening), false);
  assert.equal(await exists(oldEicAssessment), false);
});

test("dry-run raportuje plan bez kasowania", async () => {
  const logsDir = await makeLogsDir();
  await writeRun(logsDir, "2026-07-01T10-00-00-000Z", { ageDays: 400 });

  const result = await pruneLogs({ logsDir, keepRuns: 0, maxAgeDays: 30, dryRun: true });

  assert.ok(result.removed.length > 0);
  assert.ok(await exists(path.join(logsDir, "2026-07-01T10-00-00-000Z.jsonl")));
});

test("sprząta zrzuty UI zapisane wprost w logs/", async () => {
  const logsDir = await makeLogsDir();
  const stray = path.join(logsDir, "ui-screenshot-settings.png");
  await fsp.writeFile(stray, "x", "utf8");

  await pruneLogs({ logsDir, keepRuns: 50, maxAgeDays: 30 });
  assert.equal(await exists(stray), false);
});

test("formatBytes skraca rozmiary do czytelnej postaci", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

async function makeLogsDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-logs-"));
  await fsp.mkdir(path.join(dir, "screenshots"), { recursive: true });
  return dir;
}

async function writeRun(logsDir, runId, { ageDays }) {
  const logFile = path.join(logsDir, `${runId}.jsonl`);
  const shotDir = path.join(logsDir, "screenshots", runId);
  await fsp.writeFile(logFile, `{"type":"run_started"}\n`, "utf8");
  await fsp.mkdir(shotDir, { recursive: true });
  await fsp.writeFile(path.join(shotDir, "error.png"), "png-bytes", "utf8");
  await age(logFile, ageDays);
  await age(shotDir, ageDays);
}

async function age(target, days) {
  const when = new Date(Date.now() - days * DAY);
  await fsp.utimes(target, when, when);
}

async function exists(target) {
  return fsp.access(target).then(() => true, () => false);
}
