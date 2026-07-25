import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  currentPaginationValue,
  detectReviewerPageState,
  readReviewerPage,
  waitForReviewerArticleIdentity,
} from "../src/select-reviewers.js";

const reviewerArticleSnapshot = "/Users/itaprac/Downloads/Invite_R.html";
const selectQueueSnapshot = "/Users/itaprac/Downloads/Select_reviewers_list.html";
const adminCenterSnapshot = "/Users/itaprac/Downloads/admin_center.html";

test("recognizes the ScholarOne login screen that appeared after Invite All", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main>
        <h1>ScholarOne Manuscripts</h1>
        <label>User ID <input id="USERID" name="USERID"></label>
        <label>Password <input id="PASSWORD" name="PASSWORD" type="password"></label>
        <a id="logInButton" href="#">Log In</a>
      </main>
    `);
    assert.equal(await detectReviewerPageState(page), "login");
  } finally {
    await browser.close();
  }
});

test("distinguishes the exact reviewer queue from another admin queue", {
  skip: fs.existsSync(selectQueueSnapshot) ? false : `Brak snapshotu: ${selectQueueSnapshot}`,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(selectQueueSnapshot).href, { waitUntil: "load" });
    assert.equal(await detectReviewerPageState(page, "Select Reviewers"), "reviewer_queue");
    assert.equal(await detectReviewerPageState(page, "Invite Reviewers"), "other_admin_queue");
  } finally {
    await browser.close();
  }
});

test("recognizes an empty Invite Reviewers queue without a Select dropdown", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <input type="hidden" name="CURRENT_PAGE" value="ADMIN_VIEW_MANUSCRIPTS">
      <h1><b>Invite Reviewers</b></h1>
      <p>No manuscripts are in this queue.</p>
    `);
    assert.equal(await detectReviewerPageState(page, "Invite Reviewers"), "reviewer_queue");
  } finally {
    await browser.close();
  }
});

test("does not wait for the default timeout when Invite Reviewers has no pagination", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<main>Invite Reviewers</main>");
    const value = await Promise.race([
      currentPaginationValue(page, "select[name='pageSelector']"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("pagination lookup timed out")), 1_000)),
    ]);
    assert.equal(value, null);
  } finally {
    await browser.close();
  }
});

test("reads a reviewer whose removed account name is plain text instead of a link", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <table><tr><td><b>Reviewer List</b> 1-2 of 2</td></tr></table>
      <table>
        <tr>
          <td><input name="XIK_RP_ID_1" value="reviewer-1"></td>
          <td><a href="#reviewer">Normal, Reviewer</a></td>
          <td>Agreed</td>
          <td>Agreed: 01-Jul-2026</td>
        </tr>
        <tr>
          <td><input name="XIK_RP_ID_2" value="reviewer-2"></td>
          <td>Sant'Anna, Angelo Marcio Oliveira</td>
          <td>Account Removed</td>
          <td>Invited: 01-Jun-2026</td>
        </tr>
      </table>
    `);
    const result = await readReviewerPage(page);
    assert.equal(result.range.total, 2);
    assert.deepEqual(result.reviewers.map(({ name, status }) => ({ name, status })), [
      { name: "Normal, Reviewer", status: "Agreed" },
      { name: "Sant'Anna, Angelo Marcio Oliveira", status: "Account Removed" },
    ]);
  } finally {
    await browser.close();
  }
});

test("recognizes reviewer details and Admin Center snapshots", {
  skip: fs.existsSync(reviewerArticleSnapshot) && fs.existsSync(adminCenterSnapshot)
    ? false
    : "Brak snapshotów Invite_R.html/admin_center.html",
}, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(reviewerArticleSnapshot).href, { waitUntil: "load" });
    assert.equal(await detectReviewerPageState(page), "reviewer_article");

    await page.goto(pathToFileURL(adminCenterSnapshot).href, { waitUntil: "load" });
    assert.equal(await detectReviewerPageState(page), "admin_center");
  } finally {
    await browser.close();
  }
});

test("waits through the transient shell after Invite All instead of leaving for a queue", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent("<main>ScholarOne is loading the updated manuscript…</main>");
    await page.evaluate(() => {
      setTimeout(() => {
        document.body.innerHTML = `
          <input type="hidden" name="CURRENT_PAGE" value="MANUSCRIPT_DETAILS">
          <p>KES-25-0297.R1</p>
          <table><tr><td><b>Reviewer List</b> 1 - 1 of 1</td></tr></table>
          <table><tr><td>Potential Reviewer Details</td></tr></table>
        `;
      }, 1200);
    });

    const result = await waitForReviewerArticleIdentity(page, "KES-25-0297.R1", 5_000);
    assert.equal(result.ready, true);
    assert.equal(result.state, "reviewer_article");
    assert.deepEqual(result.observedStates, ["unknown", "reviewer_article"]);
  } finally {
    await browser.close();
  }
});
