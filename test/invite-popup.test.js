import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { extractPopWindowTarget } from "../src/select-reviewers.js";
import { REVIEWER_SELECTORS } from "../src/reviewer-selectors.js";
import { fixturePath, readFixture } from "./fixtures.js";
import { clickFinalInviteAll, openInviteAllPopup } from "../src/reviewers/invitations.js";

test("does not wait for a window close after the final popup has navigated", async () => {
  let clicked = 0;
  const popup = {
    on() {}, off() {}, url: () => "https://scholarone.test/popup", isClosed: () => false,
    waitForEvent: () => new Promise(() => {}),
    waitForNavigation: async () => {},
    locator: () => ({ count: async () => 1, click: async () => { clicked += 1; } }),
  };
  const result = await Promise.race([
    clickFinalInviteAll(popup, async () => {}),
    new Promise((resolve) => setTimeout(() => resolve(null), 100)),
  ]);
  assert.ok(result, "navigation is sufficient to start verification in the opener");
  assert.equal(result.clicked, true);
  assert.equal(result.popupClosed, false);
  assert.equal(clicked, 1);
});

test("waits for the first Invite All button after the reviewer list is ready", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route("https://scholarone.test/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: `
        <a href="javascript:void('EN_MASS_INVITE_POPUP')"><img src="/invite_all.gif" width="30" height="20"></a>` });
    });
    await page.setContent(`<p>Reviewer List ready</p><script>setTimeout(() => {
      document.body.insertAdjacentHTML('beforeend', '<a href="https://scholarone.test/invite_all_popup" target="invite_all_popup"><img src="/invite_all.gif" width="30" height="20"></a>');
    }, 75)</script>`);
    const popup = await openInviteAllPopup(page, async () => {});
    assert.notEqual(popup, page);
    assert.match(popup.url(), /invite_all_popup/);
  } finally {
    await browser.close();
  }
});

test("waits for new contents when ScholarOne reuses a named invitation popup", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route("https://scholarone.test/**", async (route) => {
      const old = new URL(route.request().url()).pathname === "/old";
      if (!old) await new Promise((resolve) => setTimeout(resolve, 150));
      await route.fulfill({ contentType: "text/html", body: `<p>${old ? "Old invitation" : "New invitation"}</p>
        <a href="javascript:void('EN_MASS_INVITE_POPUP')"><img src="/invite_all.gif" width="30" height="20"></a>` });
    });
    const page = await context.newPage();
    await page.setContent(`<button onclick="window.open('https://scholarone.test/old','invite_all_popup')">Open</button>
      <a href="https://scholarone.test/new_invite_all_popup" target="invite_all_popup"><img src="/invite_all.gif" width="30" height="20"></a>`);
    const opened = page.waitForEvent("popup");
    await page.locator("button").click();
    const oldPopup = await opened;
    await oldPopup.waitForLoadState("domcontentloaded");
    const popup = await openInviteAllPopup(page, async () => {});
    assert.equal(popup, oldPopup);
    assert.equal(await popup.locator("p").innerText(), "New invitation");
  } finally {
    await browser.close();
  }
});

const finalInvitePopupFile = fixturePath("invitePopup");

test("extracts the first Invite All URL from ScholarOne popWindow markup", () => {
  const html = readFixture("firstInviteAll");
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

test("the final Invite All accepts ScholarOne confirmation and invokes the mass-invite action", async () => {
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
