import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { submitScholarOneLinkByText } from "../src/core/dom.js";
import { navigateToAdminQueue } from "../src/steps/queue.js";
import { submitScholarOneLinkByImageAlt } from "../src/steps/reject-email.js";

for (const [kind, submit, link] of [
  ["text link", submitScholarOneLinkByText, `<a href="javascript:setNextPage('DASHBOARD')">Admin Center</a>`],
  ["image link", submitScholarOneLinkByImageAlt, `<a href="javascript:setDataAndNextPage('DOC_ID','next','DASHBOARD')"><img alt="Admin Center"></a>`],
]) {
test(`waits for the submitted document before the next workflow step: ${kind}`, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let releaseResponse;
    const responseGate = new Promise((resolve) => { releaseResponse = resolve; });
    let requestStarted;
    const requestGate = new Promise((resolve) => { requestStarted = resolve; });
    await page.route("https://scholarone.test/**", async (route) => {
      if (route.request().method() === "POST") {
        requestStarted();
        await responseGate;
        await route.fulfill({ contentType: "text/html", body: "<b>Admin Center ready</b>" });
      } else {
        await route.fulfill({ contentType: "text/html", body: `
          <form method="post"><input name="NEXT_PAGE">
          ${link}</form>
        ` });
      }
    });
    await page.goto("https://scholarone.test/");
    let finished = false;
    const submission = submit(page, /^Admin Center$/i)
      .then((result) => { finished = true; return result; });
    await requestGate;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const returnedBeforeResponse = finished;
    releaseResponse();
    assert.equal(await submission, true);
    assert.equal(returnedBeforeResponse, false, "workflow continued on the previous document");
    assert.match(await page.locator("body").innerText(), /Admin Center ready/);
  } finally {
    await browser.close();
  }
});
}

test("opens the queue from the new dashboard instead of a same-name manuscript tab", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const destinations = [];
    const form = (content) => `<form method="post"><input name="NEXT_PAGE">${content}</form>`;
    await page.route("https://scholarone.test/**", async (route) => {
      const destination = new URLSearchParams(route.request().postData() || "").get("NEXT_PAGE");
      if (destination) destinations.push(destination);
      let body;
      if (destination === "DASHBOARD") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        body = form(`<a href="javascript:setNextPage('ADMIN_VIEW_MANUSCRIPTS')">Select Reviewers</a>`);
      } else if (destination === "ADMIN_VIEW_MANUSCRIPTS") {
        body = `<input name="CURRENT_PAGE" value="ADMIN_VIEW_MANUSCRIPTS"><b>Select Reviewers</b>
          <select name="SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_1"><option>View Details</option></select>`;
      } else {
        body = form(`<a href="javascript:setNextPage('DASHBOARD')">Admin Center</a>
          <a href="javascript:setNextPage('WRONG_MANUSCRIPT_TAB')">Select Reviewers</a>`);
      }
      await route.fulfill({ contentType: "text/html", body });
    });
    await page.goto("https://scholarone.test/");
    assert.equal(await navigateToAdminQueue(page, "Select Reviewers"), true);
    assert.deepEqual(destinations, ["DASHBOARD", "ADMIN_VIEW_MANUSCRIPTS"]);
  } finally {
    await browser.close();
  }
});
