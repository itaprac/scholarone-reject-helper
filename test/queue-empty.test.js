import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  isAdminQueueEmpty,
  isCompleteChecklistQueueEmpty,
  isCurrentAdminQueue,
  ensureManuscriptListReady,
  setQueueContext,
  openNextUnseenViewDetailsAcrossQueuePages,
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

test("does not scan another queue when the requested queue has zero manuscripts", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input name="CURRENT_PAGE" value="ADMIN_VIEW_MANUSCRIPTS">
      <b>Select Reviewers</b><p>0 Complete Checklist</p>
      <table><tr><td>KES-26-9999</td><td><select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_1">
      <option>View Details</option></select></td></tr></table>`);
    setQueueContext({ config: { maxChecked: 10, assessmentQueueLabel: "Complete Checklist" } });
    await ensureManuscriptListReady(page);
    assert.equal(await openNextUnseenViewDetailsAcrossQueuePages(page, new Set()), false);
  } finally {
    setQueueContext({ config: {} });
    await browser.close();
  }
});

test("finishes an empty EIC queue without reporting missing View Details", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input name="CURRENT_PAGE" value="ADMIN_VIEW_MANUSCRIPTS">
      <b>Awaiting EIC Assignment</b><p>No manuscripts are in this queue.</p>`);
    setQueueContext({ config: { assessmentQueueLabel: "Awaiting EIC Assignment" } });
    assert.equal(await isAdminQueueEmpty(page, "Awaiting EIC Assignment"), true);
    await ensureManuscriptListReady(page);
  } finally {
    setQueueContext({ config: {} });
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
