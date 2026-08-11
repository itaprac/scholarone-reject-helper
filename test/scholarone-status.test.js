import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  readScholarOneQueueCounts,
  SCHOLARONE_QUEUE_DEFINITIONS,
} from "../src/scholarone-status.js";
import { FIXTURES, fixturePath } from "./fixtures.js";

test("reads all known Admin Center queue counters without opening a queue", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ javaScriptEnabled: false });

  try {
    await page.goto(pathToFileURL(fixturePath(FIXTURES.admin)).href, { waitUntil: "load" });
    const queues = await readScholarOneQueueCounts(page);
    const counts = Object.fromEntries(queues.map(({ key, count }) => [key, count]));

    assert.deepEqual(counts, {
      "complete-checklist": 111,
      "awaiting-eic-assignment": 0,
      "assign-reviewers": 1,
      "select-reviewers": 27,
      "invite-reviewers": 1,
      "awaiting-reviewer-scores": 0,
      "overdue-reviewer-scores": 12,
      "rescinded-reviewer-scores": 0,
      "assign-ae": 0,
      "make-recommendation": 6,
      "make-final-decision": 0,
    });
    assert.equal(queues.length, SCHOLARONE_QUEUE_DEFINITIONS.length);
  } finally {
    await browser.close();
  }
});

test("reports a ScholarOne layout change instead of returning partial counters", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent("<table><tr><td>12</td><td>Complete Checklist</td></tr></table>");
    await assert.rejects(
      () => readScholarOneQueueCounts(page),
      (error) => error.code === "layout_changed"
    );
  } finally {
    await browser.close();
  }
});
