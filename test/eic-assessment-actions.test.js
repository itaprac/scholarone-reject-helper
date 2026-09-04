import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { inspectImmediateDecision } from "../src/eic-decision.js";
import { openManuscriptTabByIdAcrossQueuePages, setQueueContext } from "../src/steps/queue.js";

test("opens Immediate Decision directly from the exact Select Reviewers queue row", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const decisionHtml = Buffer.from(`
      <p>KES-26-1097</p>
      <table><tr><td><input type="radio" name="T123_XIK_TASK_REC_DEC_ID" value="reject"></td><td>Reject - Fatally Flawed</td></tr></table>
      <a id="createDraftEmailBtn_123">Create Draft E-mail</a>
      <a id="CommitDecision">Commit Decision</a>
    `).toString("base64");
    await page.setContent(`
      <table>
        <tr><td>KES-26-9999</td><td><select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_1"><option>Select...</option><option value="wrong">Immediate Decision</option></select></td></tr>
        <tr><td>KES-26-1097</td><td><select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_2" onchange="document.body.innerHTML=atob('${decisionHtml}')"><option>Select...</option><option value="target">Immediate Decision</option></select></td></tr>
      </table>
    `);

    const opened = await openManuscriptTabByIdAcrossQueuePages(
      page,
      "KES-26-1097",
      /^Immediate\s+Decision$/i,
      { navigationTimeout: 50 }
    );

    assert.equal(opened, true);
    const state = await inspectImmediateDecision(page);
    assert.equal(state.reject.length, 1);
    assert.equal(state.commitButtons, 1);
  } finally {
    await browser.close();
  }
});

test("keeps searching Select Reviewers across pages during an EIC workflow", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    setQueueContext({ config: { assessmentQueueLabel: "Awaiting EIC Assignment" } });
    await page.route("https://scholarone.test/**", async (route) => {
      const current = new URLSearchParams(route.request().postData() || "").get("CURRENT_PAGE_NO") || "1";
      const id = current === "1" ? "KES-26-9999" : "KES-26-1097";
      await route.fulfill({ contentType: "text/html", body: `<form method="post">
        <input name="CURRENT_PAGE" value="ADMIN_VIEW_MANUSCRIPTS"><b>Select Reviewers</b>
        <select name="page_select"><option value="1">1</option>
        <option value="2" ${current === "2" ? "selected" : ""}>2</option></select>
        <table><tr><td>${id}</td><td>
        <select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_1" onchange="document.body.innerHTML='<p>Target opened</p>'">
          <option>Select...</option><option value="details">View Details</option>
          <option value="decision">Immediate Decision</option>
        </select></td></tr></table></form>` });
    });
    await page.goto("https://scholarone.test/");
    assert.equal(await openManuscriptTabByIdAcrossQueuePages(
      page, "KES-26-1097", /^Immediate\s+Decision$/i,
      { navigationTimeout: 50, queueLabel: "Select Reviewers" }
    ), true);
    assert.equal(await page.locator("body").innerText(), "Target opened");
  } finally {
    setQueueContext({ config: {} });
    await browser.close();
  }
});

test("does not open a tab from a different manuscript row", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <table><tr><td>KES-26-9999</td><td><select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_1"><option>Select...</option><option value="wrong">Immediate Decision</option></select></td></tr></table>
    `);
    const opened = await openManuscriptTabByIdAcrossQueuePages(
      page,
      "KES-26-1097",
      /^Immediate\s+Decision$/i,
      { navigationTimeout: 50 }
    );
    assert.equal(opened, false);
  } finally {
    await browser.close();
  }
});

test("does not confuse a manuscript with its revision or a longer ID", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<table>
      ${["KES-26-1097.R1", "KES-26-10970"].map((id, index) => `
        <tr><td>${id}</td><td><select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_${index}">
        <option>Select...</option><option value="wrong">Immediate Decision</option></select></td></tr>
      `).join("")}</table>`);
    assert.equal(await openManuscriptTabByIdAcrossQueuePages(
      page, "KES-26-1097", /^Immediate\s+Decision$/i, { navigationTimeout: 50 }
    ), false);
  } finally {
    await browser.close();
  }
});
