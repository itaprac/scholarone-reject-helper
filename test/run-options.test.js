import test from "node:test";
import assert from "node:assert/strict";
import { validateRunOptions } from "../src/run-options.js";

const VALID_OPTIONS = {
  startUrl: "https://mc.manuscriptcentral.com/kes",
  maxChecked: "50",
  submittedOlderThanDays: "30",
  queueStartPage: "2",
  slowMo: "0",
  maxRejected: "4",
};

test("accepts the existing valid options for every run mode", () => {
  assert.doesNotThrow(() => validateRunOptions(VALID_OPTIONS, "dryrun"));
  assert.doesNotThrow(() => validateRunOptions(VALID_OPTIONS, "live"));
  assert.doesNotThrow(() => validateRunOptions(VALID_OPTIONS, "send-from-report"));
});

test("accepts empty optional values", () => {
  assert.doesNotThrow(() => validateRunOptions({
    startUrl: "",
    queueStartPage: "",
    maxRejected: "",
  }, "live"));
});

test("rejects a negative submission age", () => {
  assertBadRequest(
    () => validateRunOptions({ submittedOlderThanDays: "-1" }, "live"),
    /submittedOlderThanDays/
  );
});

test("rejects zero as max rejected instead of treating it as no limit", () => {
  assertBadRequest(
    () => validateRunOptions({ maxRejected: "0" }, "live"),
    /maxRejected/
  );
});

test("keeps zero as a valid slow motion value", () => {
  assert.doesNotThrow(() => validateRunOptions({ slowMo: "0" }, "dryrun"));
});

test("rejects partial integers and invalid start URLs", () => {
  assertBadRequest(
    () => validateRunOptions({ maxChecked: "10abc" }, "dryrun"),
    /maxChecked/
  );
  assertBadRequest(
    () => validateRunOptions({ startUrl: "not a URL" }, "dryrun"),
    /Start URL/
  );
});

test("validates reviewer preparation and invitation batches", () => {
  assert.doesNotThrow(() => validateRunOptions({
    reviewerStartUrl: "https://mc.manuscriptcentral.com/kes",
    reviewerQueue: "select",
    reviewersPerPaper: "10",
    reviewerMaxManuscripts: "1",
    reviewerSlowMo: "0",
  }, "reviewers-prepare"));

  assert.doesNotThrow(() => validateRunOptions({
    reviewerStartUrl: "https://mc.manuscriptcentral.com/kes",
    reviewerQueue: "invite",
    reviewersPerPaper: "10",
    reviewerMaxManuscripts: "5",
    reviewerSlowMo: "500",
  }, "reviewers-invite"));

  assert.doesNotThrow(() => validateRunOptions({
    reviewerQueue: "combined",
    reviewersPerPaper: "10",
    reviewerMaxManuscripts: "3",
    reviewerSlowMo: "500",
    reviewerRefreshWaitSeconds: "60",
  }, "reviewers-invite"));
});

test("reviewer refresh wait must be at least one second", () => {
  assertBadRequest(() => validateRunOptions({
    reviewerQueue: "combined",
    reviewerRefreshWaitSeconds: "0",
  }, "reviewers-invite"), /reviewerRefreshWaitSeconds/);
});

test("safe reviewer preparation cannot silently become a batch", () => {
  assertBadRequest(() => validateRunOptions({
    reviewerQueue: "select",
    reviewerMaxManuscripts: "2",
  }, "reviewers-prepare"), /jeden manuskrypt/);
});

function assertBadRequest(callback, messagePattern) {
  assert.throws(callback, (error) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, messagePattern);
    return true;
  });
}
