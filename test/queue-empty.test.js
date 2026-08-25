import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  isAdminQueueEmpty,
  isCompleteChecklistQueueEmpty,
  isCurrentAdminQueue,
} from "../src/steps/queue.js";

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

test("distinguishes Awaiting EIC Assignment from another admin queue", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <input type="hidden" name="CURRENT_PAGE" value="ADMIN_VIEW_MANUSCRIPTS">
      <b>Awaiting EIC Assignment</b>
      <div>0 Complete Checklist</div>
      <div>20 Awaiting EIC Assignment</div>
    `);
    assert.equal(await isCurrentAdminQueue(page, "Awaiting EIC Assignment"), true);
    assert.equal(await isCurrentAdminQueue(page, "Complete Checklist"), false);
    assert.equal(await isAdminQueueEmpty(page, "Awaiting EIC Assignment"), false);
  } finally {
    await browser.close();
  }
});
