import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  readAllReviewerList,
  readCandidatePage,
  readExistingEmailConflict,
  readReviewerPage,
  waitForReviewerListReady,
} from "../src/select-reviewers.js";
import { REVIEWER_SELECTORS } from "../src/reviewer-selectors.js";

const htmlDir = process.env.SCHOLARONE_HTML_DIR || "/Users/itaprac/Downloads";
const files = {
  home: path.join(htmlDir, "ScholarOne Manuscripts.html"),
  admin: path.join(htmlDir, "admin_center.html"),
  queue: path.join(htmlDir, "Select_reviewers_list.html"),
  article: path.join(htmlDir, "selecxt_reviweers_article.html"),
  createAccount: path.join(htmlDir, "nwe_acc_add.html"),
  invitePopup: path.join(htmlDir, "ivniteall_popup.html"),
  firstInviteAll: path.join(htmlDir, "invite_all_first.html"),
};
const missing = Object.values(files).filter((file) => !fs.existsSync(file));

test("offline ScholarOne selectors match every supplied HTML snapshot", {
  skip: missing.length ? `Brak snapshotów: ${missing.join(", ")}` : false,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ javaScriptEnabled: false });

  try {
    const admin = await loadPage(context, files.admin);
    assert.equal(await admin.getByRole("link", { name: /^Select Reviewers$/i }).count(), 1);

    const queue = await loadPage(context, files.queue);
    const queueActions = queue.locator(REVIEWER_SELECTORS.queueAction);
    assert.ok(await queueActions.count() > 0);
    assert.equal(await queueActions.first().locator("option", { hasText: /^Select Reviewers$/i }).count(), 1);
    assert.deepEqual(
      await queue.locator(REVIEWER_SELECTORS.queuePagination).first().locator("option").allTextContents(),
      ["1-10", "11-20", "21-27"]
    );
    assert.equal(await queue.locator(REVIEWER_SELECTORS.queueCurrentPage).count(), 1);

    const article = await loadPage(context, files.article);
    const articleReviewers = await readReviewerPage(article);
    const articleCandidates = await readCandidatePage(article);
    assert.deepEqual(articleReviewers.range, { start: 1, end: 2, total: 2, empty: false });
    assert.equal(articleReviewers.reviewers.length, 2);
    assert.equal((await readAllReviewerList(article)).length, 2);
    assert.equal(articleCandidates.length, 10);
    assert.ok(articleCandidates.some(({ popupExpected }) => popupExpected));
    assert.ok(articleCandidates.some(({ popupExpected }) => !popupExpected));
    assert.deepEqual(
      await article.locator(REVIEWER_SELECTORS.candidatePagination).locator("option").allTextContents(),
      ["1-10", "11-20", "21-25"]
    );
    const refreshSearch = article.locator(REVIEWER_SELECTORS.refreshSearch);
    assert.equal(await refreshSearch.count(), 1);
    assert.match(await refreshSearch.getAttribute("href"), /NUM_REQUESTED.+RL_JUST_PAGED.+XIK_CURRENT_DOCUMENT_TASK_ID/is);

    const home = await loadPage(context, files.home);
    const homeReviewers = await readReviewerPage(home);
    const homeCandidates = await readCandidatePage(home);
    assert.deepEqual(homeReviewers.range, { start: 1, end: 11, total: 11, empty: false });
    assert.equal(homeReviewers.reviewers.length, 11);
    assert.equal((await readAllReviewerList(home)).length, 11);
    assert.equal(homeCandidates.length, 9);
    assert.ok(homeCandidates.every(({ popupExpected }) => !popupExpected));

    const createAccount = await loadPage(context, files.createAccount);
    assert.equal(await createAccount.locator(REVIEWER_SELECTORS.createAndAdd).count(), 1);
    assert.equal(await createAccount.locator("input[name='PERSON_FIRSTNAME']").inputValue(), "Bijoy Krishna");
    assert.equal(await createAccount.locator("input[name='EMAIL_ADDRESS']").inputValue(), "bijoy91@tezu.ernet.in");

    const firstInviteAllPage = await context.newPage();
    await firstInviteAllPage.goto(pathToFileURL(files.firstInviteAll).href, { waitUntil: "load" });
    const firstInviteAll = firstInviteAllPage.locator(REVIEWER_SELECTORS.firstInviteAll);
    await firstInviteAll.waitFor({ state: "visible" });
    assert.equal(await firstInviteAll.count(), 1);
    assert.match(await firstInviteAll.getAttribute("href"), /popWindow\(.+invite_all_popup/is);

    const invitePopup = await context.newPage();
    await invitePopup.goto(pathToFileURL(files.invitePopup).href, { waitUntil: "load" });
    const finalInviteAll = invitePopup.locator(REVIEWER_SELECTORS.finalInviteAll);
    await finalInviteAll.waitFor({ state: "visible" });
    assert.equal(await finalInviteAll.count(), 1);
    assert.match(await finalInviteAll.getAttribute("href"), /confirm\(.+invite all.+setDataAndNextPage/is);
    assert.equal(await invitePopup.locator("input[name='REVIEW_PERSON_ID_EN_MASS']").count(), 10);
  } finally {
    await browser.close();
  }
});

test("Reviewer List readiness tolerates ScholarOne's temporary blank shell", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent("<html><body><nav>Manage</nav></body></html>");
    const ready = waitForReviewerListReady(page, 2_000);
    await page.waitForTimeout(100);
    await page.setContent(`
      <table>
        <tr><td><b>Reviewer List</b></td><td>1 - 1 of 1</td></tr>
        <tr>
          <td><input name="XIK_RP_ID_1" value="reviewer-1"></td>
          <td><a>Malik, Muhammad Shahid Iqbal</a></td>
          <td></td>
          <td>Selected: 13-Jul-2026</td>
        </tr>
      </table>
    `);

    assert.match((await ready).headerText, /1\s*-\s*1\s+of\s+1/i);
    const result = await readReviewerPage(page);
    assert.equal(result.reviewers[0].name, "Malik, Muhammad Shahid Iqbal");
  } finally {
    await browser.close();
  }
});

test("existing-email Create Account state exposes an image-only Save and Add", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <p>A person with this e-mail address already exists in the system:</p>
      <p>Alam, Md. Golam Rabiul;</p>
      <p>To use this existing person, click the "Save and Add" button.</p>
      <input name="EMAIL_ADDRESS" value="rabiul.alam@bracu.ac.bd">
      <a href="javascript:window.close()"><img src="/images/en_US/buttons/close_window.gif" width="100" height="18"></a>
      <a href="javascript:void(0)"><img src="/images/en_US/buttons/save_add.gif" width="120" height="18"></a>
    `);

    assert.deepEqual(await readExistingEmailConflict(page, {
      name: "Md Golam Rabiul Alam",
      email: "rabiul.alam@bracu.ac.bd",
    }), {
      email: "rabiul.alam@bracu.ac.bd",
      emailMatches: true,
      controlCount: 1,
      controlVisible: true,
    });
    assert.equal((await readExistingEmailConflict(page, {
      name: "Different Person",
      email: "different@example.com",
    })).emailMatches, false);
  } finally {
    await browser.close();
  }
});

test("existing-email Create Account state supports ScholarOne's generic save.gif button", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <p>A person with this e-mail address already exists in the system:</p>
      <p>Alam, Md. Golam Rabiul;</p>
      <p>To use this existing person, click the "Save and Add" button.</p>
      <input name="EMAIL_ADDRESS" value="rabiul.alam@bracu.ac.bd">
      <a href="javascript:window.close()"><img src="/images/en_US/buttons/close_window.gif" width="100" height="18"></a>
      <a href="javascript:void(0)"><img src="/images/en_US/buttons/save.gif" width="52" height="18"></a>
    `);

    const conflict = await readExistingEmailConflict(page, {
      name: "Md Golam Rabiul Alam",
      email: "rabiul.alam@bracu.ac.bd",
    });
    assert.equal(conflict.controlCount, 1);
    assert.equal(conflict.controlVisible, true);
  } finally {
    await browser.close();
  }
});

async function loadPage(context, file) {
  const page = await context.newPage();
  await page.setContent(await fsp.readFile(file, "utf8"), { waitUntil: "domcontentloaded" });
  return page;
}
