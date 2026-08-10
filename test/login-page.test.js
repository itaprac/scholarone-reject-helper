import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { isLoginPage } from "../src/core/login.js";

test("known ScholarOne login controls win over misleading logged-in text", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <p>Admin Center instructions</p>
        <input id="USERID" name="USERID" />
        <input id="PASSWORD" name="PASSWORD" type="password" />
        <a id="logInButton" href="#">Log In</a>
      </main>
    `);
    assert.equal(await isLoginPage(page), true);
  } finally {
    await browser.close();
  }
});
