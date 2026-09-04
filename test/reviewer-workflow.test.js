import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findQuickSearchReviewerAction, openReviewerArticle, runOneReviewerManuscript, runSelectReviewers, waitForReviewerRefresh } from "../src/select-reviewers.js";
import { waitForInvitationConfirmation } from "../src/reviewers/invitations.js";

test("an unchanged roster remains unconfirmed when the verification deadline expires", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input name="CURRENT_PAGE" value="MANUSCRIPT_DETAILS"><p>KES-26-9001.R1</p>
      <table><tr><td><b>Reviewer List</b> 1-1 of 1</td></tr></table>
      <table><tr><td><input name="XIK_RP_ID_1" value="one"></td><td>Sample Reviewer</td><td>Selected</td><td></td></tr></table>
      <p>1 active selections; 0 invited; 0 agreed; 0 declined; 0 returned</p>`);
    const result = await waitForInvitationConfirmation(page, {
      manuscriptId: "KES-26-9001.R1", beforeCounters: { invited: 0 },
      expected: [{ id: "one", name: "Sample Reviewer" }], log: async () => {}, timeout: 100,
    });
    assert.equal(result.confirmed, false);
    assert.equal(result.invitedIncrease, 0);
  } finally {
    await browser.close();
  }
});

test("an empty reviewer queue at startup completes without an error", async () => {
  const browser = await chromium.launch({ headless: true });
  const logsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "reviewer-empty-"));
  try {
    const page = await browser.newPage();
    await page.route("https://scholarone.test/**", (route) => route.fulfill({
      contentType: "text/html", body: `<input name="CURRENT_PAGE" value="ADMIN_VIEW_MANUSCRIPTS">
        <b>Invite Reviewers</b><p>No manuscripts are in this queue.</p>`,
    }));
    await page.goto("https://scholarone.test/queue");
    const result = await runSelectReviewers([
      "--start-url=https://scholarone.test/queue", `--logs-dir=${logsDir}`,
      "--reviewer-queue=invite", "--auto-login=false", "--keep-open=false", "--slow-mo=0",
    ], { createSession: async () => ({ page, close: async () => {} }) });
    assert.equal(result.queueExhausted, true);
    assert.equal(result.completed, 0);
    const status = JSON.parse(await fsp.readFile(path.join(logsDir, "current-run.json"), "utf8"));
    assert.equal(status.status, "finished");
  } finally {
    await browser.close();
    await fsp.rm(logsDir, { recursive: true, force: true });
  }
});

test("does not add a fresh wait when reviewer search ran while other papers were processed", async () => {
  let waited = 0;
  await waitForReviewerRefresh({ waitForTimeout: async (ms) => { waited += ms; } },
    { refreshWaitMs: 60_000 }, async () => {},
    { manuscriptId: "KES-26-9001", deferredAt: Date.now() - 120_000, attempts: 1 });
  assert.equal(waited, 0);
});

test("excluding the original manuscript does not exclude its revision", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://scholarone.test/**", (route) => route.fulfill({
      contentType: "text/html", body: "Opened revision",
    }));
    await page.setContent(`<table><tr><td>KES-26-9001.R1</td><td>
      <select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_1" onchange="location='https://scholarone.test/revision'">
      <option>Select...</option><option value="invite">Invite Reviewers</option></select></td></tr></table>`);
    const result = await openReviewerArticle(page, async () => {}, "Invite Reviewers", null, ["KES-26-9001"]);
    assert.match(result.rowText, /KES-26-9001.R1/);
  } finally {
    await browser.close();
  }
});

test("quick search does not open a revision for the original manuscript ID", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<table><tr><td>KES-26-9001.R1</td><td>
      <select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_1"><option value="invite">Invite Reviewers</option></select>
      </td></tr></table>`);
    assert.equal(await findQuickSearchReviewerAction(page, "KES-26-9001"), null);
  } finally {
    await browser.close();
  }
});

test("rejects a different manuscript returned after opening a queue row", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://scholarone.test/**", (route) => route.fulfill({
      contentType: "text/html", body: `<input name="CURRENT_PAGE" value="MANUSCRIPT_DETAILS">
        <p>KES-26-9002.R1</p><table><tr><td><b>Reviewer List</b> 0-0 of 0</td></tr></table>
        <p>Potential Reviewer Details</p>`,
    }));
    await page.setContent(`<input name="CURRENT_PAGE" value="ADMIN_VIEW_MANUSCRIPTS"><b>Invite Reviewers</b>
      <table><tr><td>KES-26-9001.R1</td><td><select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_1"
      onchange="location='https://scholarone.test/wrong'"><option>Select...</option>
      <option value="invite">Invite Reviewers</option></select></td></tr></table>`);
    await assert.rejects(runOneReviewerManuscript(page, {
      config: { reviewersPerPaper: 1, inviteAll: false }, log: async () => {},
      logFile: "test", screenshots: {}, batchIndex: 1, queueLabel: "Invite Reviewers",
    }), (error) => {
      assert.match(error.message, /zamiast KES-26-9001.R1/);
      assert.equal(error.reviewerContext.manuscriptId, "KES-26-9001.R1");
      return true;
    });
  } finally {
    await browser.close();
  }
});

for (const needsCandidate of [false, true]) {
test(`verifies a delayed invitation update without sending twice: ${needsCandidate ? "new candidate" : "existing reviewer"}`, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    let sends = 0;
    let adds = 0;
    const manuscriptId = needsCandidate ? "KES-26-9001" : "KES-26-9001.R1";
    await context.route("https://scholarone.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/add") {
        adds += 1;
      }
      let body;
      if (pathname === "/queue") {
        body = `<input name="CURRENT_PAGE" value="ADMIN_VIEW_MANUSCRIPTS"><b>Invite Reviewers</b>
          <table><tr><td>${manuscriptId}</td><td><select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_1" onchange="location='/article'">
          <option>Select...</option><option value="invite">Invite Reviewers</option></select></td></tr></table>`;
      } else if (pathname === "/article" || pathname === "/add") {
        const hasReviewer = !needsCandidate || adds > 0;
        body = `<script>history.replaceState(null, '', '/article')</script>
          <input name="CURRENT_PAGE" value="MANUSCRIPT_DETAILS"><p>${manuscriptId}</p>
          <table><tr><td><b>Reviewer List</b> ${hasReviewer ? "1-1 of 1" : "0-0 of 0"}</td></tr></table>
          ${hasReviewer ? `<table><tr><td><input name="XIK_RP_ID_1" value="reviewer-1"></td><td>Sample Reviewer</td>
          <td>${sends ? "Invited" : "Selected"}</td><td></td></tr></table>` : ""}
          <p>Potential Reviewer Details</p><table><tr><td><b>Sample Reviewer</b> sample@example.com</td><td>
          <a href="/add?XIK_POTENTIAL_REVIEWER_ID=candidate1"><img src="/add.gif" width="30" height="20"></a>
          </td></tr></table>
          <p>${sends ? "0 active selections; 1 invited" : "1 active selections; 0 invited"}; 0 agreed; 0 declined; 0 returned</p>
          <a href="/invite_all_popup" target="invite_all_popup"><img src="/invite_all.gif" width="30" height="20"></a>`;
      } else if (pathname === "/invite_all_popup") {
        body = `<a href="javascript:void('EN_MASS_INVITE_POPUP')" onclick="fetch('/send').then(() => {
          opener.setTimeout('location.reload()', 1000); location='/sent';
        })"><img src="/invite_all.gif" width="30" height="20"></a>`;
      } else if (pathname === "/send") {
        sends += 1;
        body = "OK";
      } else body = "Done";
      await route.fulfill({ contentType: "text/html", body });
    });
    const page = await context.newPage();
    await page.goto("https://scholarone.test/queue");
    const result = await runOneReviewerManuscript(page, {
      config: { reviewersPerPaper: 1, inviteAll: true },
      log: async () => {}, logFile: "test", screenshots: { proof: async () => "test" },
      batchIndex: 1, queueLabel: "Invite Reviewers",
    });
    assert.equal(result.status, "invite_all_confirmed");
    assert.equal(result.confirmation.confirmed, true);
    assert.equal(sends, 1);
    assert.equal(adds, needsCandidate ? 1 : 0);
  } finally {
    await browser.close();
  }
});
}
