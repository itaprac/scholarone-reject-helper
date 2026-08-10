import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATIC_REVISION_MODE,
  buildAutomaticRevisionAssessment,
  classifyScreeningManuscript,
} from "../src/screening-assessment.js";

test("automatically approves a revision without an LLM assessment", () => {
  const assessment = buildAutomaticRevisionAssessment("kes-26-1234.r3");

  assert.equal(assessment.provider, "rule");
  assert.equal(assessment.mode, AUTOMATIC_REVISION_MODE);
  assert.equal(assessment.decision, "APPROVE");
  assert.equal(assessment.durationMs, 0);
  assert.equal(assessment.outputPath, null);
  assert.match(assessment.reason, /KES-26-1234\.R3/);
});

test("refuses automatic approval for a non-revision manuscript", () => {
  assert.throws(
    () => buildAutomaticRevisionAssessment("KES-26-1234"),
    /wymaga identyfikatora rewizji/
  );
});

test("gives the revision rule priority over an unusual-activity alert", () => {
  assert.equal(classifyScreeningManuscript("KES-26-1234.R2", {
    hasUnusualActivity: true,
  }), "automatic-revision-approve");
  assert.equal(classifyScreeningManuscript("KES-26-1234", {
    hasUnusualActivity: true,
  }), "skip-unusual-activity");
  assert.equal(classifyScreeningManuscript("KES-26-1234"), "assess");
});
