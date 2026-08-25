import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  inspectImmediateDecision,
  selectImmediateReject,
} from "../src/eic-decision.js";

test("finds and selects only Reject - Fatally Flawed on Immediate Decision", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <table>
        <tr><td><input type="radio" name="T123_XIK_TASK_REC_DEC_ID" value="accept"></td><td>Accept</td></tr>
        <tr><td><input type="radio" name="T123_XIK_TASK_REC_DEC_ID" value="minor"></td><td>Minor Revision</td></tr>
        <tr><td><input type="radio" name="T123_XIK_TASK_REC_DEC_ID" value="major"></td><td>Major Revision</td></tr>
        <tr><td><input type="radio" name="T123_XIK_TASK_REC_DEC_ID" value="reject"></td><td>Reject - Fatally Flawed</td></tr>
      </table>
      <a id="createDraftEmailBtn_123" href="#">Create Draft E-mail</a>
      <a id="CommitDecision" href="#">Commit Decision</a>
    `);

    const before = await inspectImmediateDecision(page);
    assert.equal(before.radios.length, 4);
    assert.equal(before.reject.length, 1);
    assert.equal(before.draftButtons, 1);
    assert.equal(before.commitButtons, 1);

    const selected = await selectImmediateReject(page);
    assert.equal(selected.selected, true);
    assert.equal(await page.locator("input[value='reject']").isChecked(), true);
    assert.equal(await page.locator("input[value='accept']").isChecked(), false);
  } finally {
    await browser.close();
  }
});

test("fails closed when the reject decision is ambiguous", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(`
      <table>
        <tr><td><input type="radio" name="T1_XIK_TASK_REC_DEC_ID" value="reject-a"></td><td>Reject - Fatally Flawed</td></tr>
        <tr><td><input type="radio" name="T1_XIK_TASK_REC_DEC_ID" value="reject-b"></td><td>Reject - Fatally Flawed</td></tr>
      </table>
      <a id="createDraftEmailBtn_1" href="#">Create Draft E-mail</a>
      <a id="CommitDecision" href="#">Commit Decision</a>
    `);

    await assert.rejects(
      selectImmediateReject(page),
      /Oczekiwano jednej decyzji Reject - Fatally Flawed/
    );
  } finally {
    await browser.close();
  }
});
