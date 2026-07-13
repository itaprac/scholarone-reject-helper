import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { extractPopWindowTarget } from "../src/select-reviewers.js";
import { REVIEWER_SELECTORS } from "../src/reviewer-selectors.js";

const finalInvitePopupFile = "/Users/itaprac/Downloads/ivniteall_popup.html";

test("extracts the first Invite All URL from ScholarOne popWindow markup", () => {
  const html = fs.readFileSync("/Users/itaprac/Downloads/invite_all_first.html", "utf8");
  const href = html.match(/href="([^"]*invite_all_popup[^"]+)"/i)?.[1]
    ?.replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
  const target = extractPopWindowTarget(href);

  assert.match(target, /^kes\?PARAMS=xik_/);
  assert.equal(target.includes("invite_all_popup"), false);
});

test("decodes escaped separators in a popWindow URL", () => {
  assert.equal(
    extractPopWindowTarget("javascript:popWindow('kes\\x3fPARAMS=xik_123\\x26PAGE=2','invite_all_popup',900,775)"),
    "kes?PARAMS=xik_123&PAGE=2"
  );
});

test("the final Invite All accepts ScholarOne confirmation and invokes the mass-invite action", {
  skip: fs.existsSync(finalInvitePopupFile) ? false : `Brak snapshotu: ${finalInvitePopupFile}`,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(finalInvitePopupFile).href, { waitUntil: "load" });
    await page.evaluate(() => {
      window.__massInviteCall = null;
      window.setDataAndNextPage = (...args) => {
        window.__massInviteCall = args;
      };
    });
    const finalInviteAll = page.locator(REVIEWER_SELECTORS.finalInviteAll);
    await finalInviteAll.waitFor({ state: "visible" });
    assert.equal(await finalInviteAll.count(), 1);
    const dialogPromise = page.waitForEvent("dialog");
    const clickPromise = finalInviteAll.click();
    const dialog = await dialogPromise;
    const message = dialog.message();
    await dialog.accept();
    await clickPromise;

    assert.match(message, /invite all/i);
    const massInviteCall = await page.evaluate(() => window.__massInviteCall);
    assert.equal(massInviteCall?.[0], "XIK_TAGACT");
    assert.match(massInviteCall?.[1] || "", /^xik_/);
    assert.equal(massInviteCall?.[2], "EN_MASS_INVITE_POPUP");
  } finally {
    await browser.close();
  }
});
