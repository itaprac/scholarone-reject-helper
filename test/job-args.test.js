import test from "node:test";
import assert from "node:assert/strict";
import { buildJobArgs, buildReviewerJobArgs, buildScreeningJobArgs } from "../src/job-args.js";

const OPTIONS = {
  startUrl: "https://mc.manuscriptcentral.com/kes",
  maxChecked: "50",
  submittedOlderThanDays: "30",
  queueStartPage: "2",
  maxRejected: "4",
  slowMo: "500",
  rejectMessage: "Message body",
  keepOpen: true,
};

test("builds the unchanged dry-run arguments in the original order", () => {
  assert.deepEqual(buildJobArgs("dryrun", OPTIONS), [
    "--headed",
    "--dry-run",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--max-checked=50",
    "--submitted-older-than-days=30",
    "--queue-start-page=2",
    "--slow-mo=500",
    "--keep-open",
  ]);
});

test("builds the unchanged live arguments in the original order", () => {
  assert.deepEqual(buildJobArgs("live", OPTIONS), [
    "--headed",
    "--save-and-send",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--max-checked=50",
    "--submitted-older-than-days=30",
    "--queue-start-page=2",
    "--max-rejected=4",
    "--slow-mo=500",
    "--reject-message=Message body",
    "--keep-open",
  ]);
});

test("builds the unchanged report arguments in the original order", () => {
  assert.deepEqual(buildJobArgs("send-from-report", OPTIONS, {
    report: "logs/reports/example.json",
  }), [
    "--headed",
    "--save-and-send",
    "--require-targets",
    "--reject-from-report=logs/reports/example.json",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--submitted-older-than-days=30",
    "--max-rejected=4",
    "--slow-mo=500",
    "--reject-message=Message body",
    "--keep-open",
  ]);
});

test("keeps optional empty values out of the argument list", () => {
  assert.deepEqual(buildJobArgs("live", {
    maxChecked: "10",
    queueStartPage: "",
    maxRejected: "",
    keepOpen: false,
  }), [
    "--headed",
    "--save-and-send",
    "--max-checked=10",
  ]);
});

test("builds a safe reviewer preparation run", () => {
  assert.deepEqual(buildReviewerJobArgs("reviewers-prepare", {
    reviewerQueue: "select",
    reviewerStartUrl: "https://mc.manuscriptcentral.com/kes",
    reviewersPerPaper: "10",
    reviewerMaxManuscripts: "1",
    reviewerSlowMo: "500",
    reviewerKeepOpen: true,
  }), [
    "--select-reviewers",
    "--headed",
    "--reviewer-queue=select",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--reviewers-per-paper=10",
    "--max-manuscripts=1",
    "--slow-mo=500",
    "--keep-open",
  ]);
});

test("builds a reviewer invitation batch resumed from Invite Reviewers", () => {
  assert.deepEqual(buildReviewerJobArgs("reviewers-invite", {
    reviewerQueue: "invite",
    reviewerStartUrl: "https://mc.manuscriptcentral.com/kes",
    reviewersPerPaper: "10",
    reviewerMaxManuscripts: "4",
    reviewerSlowMo: "250",
    reviewerKeepOpen: false,
  }), [
    "--select-reviewers",
    "--headed",
    "--reviewer-queue=invite",
    "--invite-all",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--reviewers-per-paper=10",
    "--max-manuscripts=4",
    "--slow-mo=250",
  ]);
});

test("builds a combined reviewer queue that resumes before selecting new papers", () => {
  assert.deepEqual(buildReviewerJobArgs("reviewers-invite", {
    reviewerQueue: "combined",
    reviewersPerPaper: "10",
    reviewerMaxManuscripts: "3",
    reviewerSlowMo: "500",
    reviewerRefreshWaitSeconds: "120",
  }), [
    "--select-reviewers",
    "--headed",
    "--reviewer-queue=combined",
    "--invite-all",
    "--reviewers-per-paper=10",
    "--max-manuscripts=3",
    "--slow-mo=500",
    "--refresh-wait-seconds=120",
  ]);
});

test("builds a safe initial assessment run with Codex CLI", () => {
  assert.deepEqual(buildScreeningJobArgs({
    screeningStartUrl: "https://mc.manuscriptcentral.com/kes",
    screeningMaxChecked: "10",
    screeningSlowMo: "500",
    screeningScanAll: true,
    screeningKeepOpen: true,
    assessmentModel: "gpt-test",
    assessmentReasoningEffort: "medium",
    assessmentTimeoutSeconds: "120",
    assessmentPrompt: "Temporary prompt",
  }), [
    "--headed",
    "--collect-metadata",
    "--assess-with-llm",
    "--scan-all-metadata",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--max-checked=10",
    "--slow-mo=500",
    "--assessment-model=gpt-test",
    "--assessment-reasoning-effort=medium",
    "--assessment-timeout-seconds=120",
    "--assessment-prompt=Temporary prompt",
    "--keep-open",
  ]);
});

test("builds an explicitly live initial assessment run", () => {
  assert.deepEqual(buildScreeningJobArgs({
    screeningStartUrl: "https://mc.manuscriptcentral.com/kes",
    screeningMaxChecked: "2",
    screeningSlowMo: "500",
    screeningScanAll: false,
    screeningKeepOpen: false,
    assessmentModel: "gpt-5.6-terra",
    assessmentReasoningEffort: "medium",
    assessmentTimeoutSeconds: "120",
    assessmentPrompt: "Prompt",
    screeningRejectMessage: "Reject body",
  }, { applyDecisions: true }), [
    "--headed",
    "--collect-metadata",
    "--assess-with-llm",
    "--apply-assessment-decisions",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--max-checked=2",
    "--slow-mo=500",
    "--assessment-model=gpt-5.6-terra",
    "--assessment-reasoning-effort=medium",
    "--assessment-timeout-seconds=120",
    "--assessment-prompt=Prompt",
    "--screening-reject-message=Reject body",
  ]);
});
