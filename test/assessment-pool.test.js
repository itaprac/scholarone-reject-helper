import assert from "node:assert/strict";
import test from "node:test";
import { createTaskPool } from "../src/assessment/pool.js";
import { assessmentCacheKey, createAssessmentCache } from "../src/assessment/cache.js";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("nigdy nie przekracza zadanej równoległości", async () => {
  const pool = createTaskPool({ concurrency: 3 });
  let active = 0;
  let peak = 0;

  const tasks = Array.from({ length: 12 }, () => async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(5);
    active--;
    return true;
  });

  for (const task of tasks) await pool.add(task);
  const { results, failures } = await pool.drain();

  assert.equal(peak, 3, `równoległość wyniosła ${peak}`);
  assert.equal(results.length, 12);
  assert.equal(failures, 0);
});

test("jedno nieudane zadanie nie przewraca całej partii", async () => {
  const pool = createTaskPool({ concurrency: 2 });

  await pool.add(async () => "pierwszy");
  await pool.add(async () => { throw new Error("model nie odpowiedział"); });
  await pool.add(async () => "trzeci");

  const { results, failures } = await pool.drain();

  assert.equal(failures, 1);
  assert.equal(results[0].value, "pierwszy");
  assert.equal(results[1].reason.message, "model nie odpowiedział");
  assert.equal(results[2].value, "trzeci");
});

test("zachowuje kolejność wyników niezależnie od kolejności zakończenia", async () => {
  const pool = createTaskPool({ concurrency: 4 });
  const delays = [30, 5, 20, 1];

  for (const [index, delay] of delays.entries()) {
    await pool.add(async () => {
      await sleep(delay);
      return index;
    });
  }

  const { results } = await pool.drain();
  assert.deepEqual(results.map((entry) => entry.value), [0, 1, 2, 3]);
});

test("równoległość 1 zachowuje się jak zwykła pętla", async () => {
  const pool = createTaskPool({ concurrency: 1 });
  const order = [];

  for (const id of ["a", "b", "c"]) {
    await pool.add(async () => {
      order.push(`start-${id}`);
      await sleep(2);
      order.push(`end-${id}`);
    });
  }
  await pool.drain();

  assert.deepEqual(order, ["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
});

test("klucz cache reaguje na każdą składową oceny", () => {
  const metadata = { manuscriptId: "KES-25-0001", title: "Tytuł", abstract: "Abstrakt" };
  const options = { instructions: "Prompt", model: "m1", reasoningEffort: "medium" };
  const base = assessmentCacheKey(metadata, options);

  assert.notEqual(base, assessmentCacheKey({ ...metadata, title: "Inny" }, options));
  assert.notEqual(base, assessmentCacheKey({ ...metadata, abstract: "Inny" }, options));
  assert.notEqual(base, assessmentCacheKey(metadata, { ...options, instructions: "Inny prompt" }));
  assert.notEqual(base, assessmentCacheKey(metadata, { ...options, model: "m2" }));
  assert.notEqual(base, assessmentCacheKey(metadata, { ...options, reasoningEffort: "high" }));
  assert.equal(base, assessmentCacheKey({ ...metadata }, { ...options }));
});

test("trafienie w cache nie dolicza tokenów drugi raz", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-cache-"));
  const cache = createAssessmentCache({ directory });
  const metadata = { manuscriptId: "KES-25-0002", title: "T", abstract: "A" };
  const options = { instructions: "P", model: "m", reasoningEffort: "medium" };

  await cache.write(metadata, options, {
    decision: "REJECT",
    reason: "poza zakresem",
    durationMs: 8400,
    usage: { available: true, inputTokens: 5000, outputTokens: 900, totalTokens: 5900 },
  });

  const hit = await cache.read(metadata, options);
  assert.equal(hit.decision, "REJECT");
  assert.equal(hit.reason, "poza zakresem");
  assert.equal(hit.cached, true);
  assert.equal(hit.usage.totalTokens, 0, "trafienie nie jest nowym wywołaniem modelu");
  assert.equal(hit.durationMs, 0);
});

test("zmiana promptu unieważnia wpis w cache", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-cache-"));
  const cache = createAssessmentCache({ directory });
  const metadata = { manuscriptId: "KES-25-0003", title: "T", abstract: "A" };

  await cache.write(metadata, { instructions: "stary", model: "m", reasoningEffort: "medium" }, {
    decision: "APPROVE", reason: "ok",
  });

  assert.equal(await cache.read(metadata, { instructions: "nowy", model: "m", reasoningEffort: "medium" }), null);
});

test("wyłączony cache nic nie czyta i nic nie zapisuje", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-cache-"));
  const cache = createAssessmentCache({ directory, enabled: false });
  const metadata = { manuscriptId: "KES-25-0004", title: "T", abstract: "A" };
  const options = { instructions: "P", model: "m", reasoningEffort: "medium" };

  await cache.write(metadata, options, { decision: "APPROVE", reason: "ok" });
  assert.equal(await cache.read(metadata, options), null);
  assert.deepEqual(await fsp.readdir(directory), []);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
