import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { isCompleteChecklistQueueEmpty } from "../src/steps/queue.js";

test("recognizes a zero-count Complete Checklist queue on Admin Center", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <h1>Dashboard</h1>
        <section class="admin-lists">
          <div><span>0</span> <span>Complete Checklist</span></div>
          <div><a>13 Awaiting EIC Assignment</a></div>
        </section>
      </main>
    `);
    assert.equal(await isCompleteChecklistQueueEmpty(page), true);
  } finally {
    await browser.close();
  }
});

test("does not call a non-empty Complete Checklist queue exhausted", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div><a>2 Complete Checklist</a></div>`);
    assert.equal(await isCompleteChecklistQueueEmpty(page), false);
  } finally {
    await browser.close();
  }
});
