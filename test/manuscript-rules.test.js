import test from "node:test";
import assert from "node:assert/strict";
import {
  extractManuscriptId,
  inspectManuscriptText,
  normalizeManuscriptId,
} from "../src/manuscript-rules.js";

const NOW = new Date("2026-07-09T12:00:00.000Z");

function inspect(text, submittedOlderThanDays = 30) {
  return inspectManuscriptText(text, {
    submittedOlderThanDays,
    now: NOW,
  });
}

test("keeps revisions even when unusual activity is present", () => {
  const result = inspect(`
    Manuscript ID: KES-26-1234.R3
    Date Submitted: 01 Jan 2025
    High rate of unusual activity
  `);

  assert.equal(result.action, "skip");
  assert.equal(result.isRevision, true);
  assert.equal(result.manuscriptId, "KES-26-1234.R3");
});

test("marks unusual activity as a candidate", () => {
  const result = inspect(`
    Manuscript ID: KES-26-1234
    Date Submitted: 08 Jul 2026
    High rate of unusual activity
  `);

  assert.equal(result.action, "candidate");
  assert.equal(result.hasUnusualActivity, true);
  assert.match(result.reason, /unusual activity/i);
});

test("marks a submission older than the configured limit as a candidate", () => {
  const result = inspect(`
    Manuscript ID: KES-26-1234
    Date Submitted: 08 Jun 2026
  `);

  assert.equal(result.action, "candidate");
  assert.equal(result.submittedMoreThanLimit, true);
});

test("keeps a submission exactly on the age boundary", () => {
  const result = inspect(`
    Manuscript ID: KES-26-1234
    Date Submitted: 2026-06-09
  `);

  assert.equal(result.action, "skip");
  assert.equal(result.submittedMoreThanLimit, false);
});

test("requires manual review when the manuscript ID cannot be read", () => {
  const result = inspect("Date Submitted: 01 Jan 2025");

  assert.equal(result.action, "manual_review");
  assert.equal(result.manuscriptId, null);
});

test("extracts and normalizes supported manuscript IDs", () => {
  assert.equal(extractManuscriptId("Document number: kes-26-123456.r10"), "KES-26-123456.R10");
  assert.equal(normalizeManuscriptId(" kes-26-1234.r2 "), "KES-26-1234.R2");
});

test.todo("parse numeric slash dates deterministically instead of relying on locale");
test.todo("parse textual dates without a one-day UTC boundary shift");
