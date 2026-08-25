import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssessmentFromRunArgs,
  buildEicAssessmentJobArgs,
  buildJobArgs,
  buildReviewerJobArgs,
  buildScreeningJobArgs,
} from "../src/job-args.js";

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
    reviewerExcludeManuscriptIds: "KES-26-0001,KES-26-0002",
  }), [
    "--select-reviewers",
    "--headed",
    "--reviewer-queue=combined",
    "--invite-all",
    "--exclude-manuscript-ids=KES-26-0001,KES-26-0002",
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

test("a live assessment run can leave approvals awaiting editor assignment", () => {
  const body = {
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
    screeningApproveWithoutAssign: true,
  };

  assert.ok(buildScreeningJobArgs(body, { applyDecisions: true })
    .includes("--approve-without-assign"));

  // Dry run nie wykonuje decyzji, więc flaga nie ma prawa do niego trafić.
  assert.ok(!buildScreeningJobArgs(body).includes("--approve-without-assign"));
});

test("builds the separate EIC assessment dry run", () => {
  assert.deepEqual(buildEicAssessmentJobArgs({
    eicAssessmentStartUrl: "https://mc.manuscriptcentral.com/kes",
    eicAssessmentMaxChecked: "20",
    eicAssessmentSlowMo: "300",
    eicAssessmentScanAll: true,
    eicAssessmentKeepOpen: false,
    eicAssessmentModel: "gpt-test",
    eicAssessmentReasoningEffort: "high",
    eicAssessmentTimeoutSeconds: "180",
    eicAssessmentPrompt: "Strict prompt",
  }), [
    "--headed",
    "--assessment-stage=eic",
    "--collect-metadata",
    "--assess-with-llm",
    "--scan-all-metadata",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--max-checked=20",
    "--slow-mo=300",
    "--assessment-model=gpt-test",
    "--assessment-reasoning-effort=high",
    "--assessment-timeout-seconds=180",
    "--assessment-prompt=Strict prompt",
  ]);
});

test("live EIC assessment includes its own rejection message", () => {
  const args = buildEicAssessmentJobArgs({
    eicAssessmentMaxChecked: "2",
    eicAssessmentModel: "gpt-test",
    eicAssessmentReasoningEffort: "medium",
    eicAssessmentTimeoutSeconds: "120",
    eicAssessmentPrompt: "Strict prompt",
    eicAssessmentRejectMessage: "Second-stage reject body",
  }, { applyDecisions: true });

  assert.ok(args.includes("--assessment-stage=eic"));
  assert.ok(args.includes("--apply-assessment-decisions"));
  assert.ok(args.includes("--screening-reject-message=Second-stage reject body"));
  assert.equal(args.includes("--approve-without-assign"), false);
});

test("executes a saved EIC run with the UI rejection message", () => {
  assert.deepEqual(buildAssessmentFromRunArgs({
    eicAssessmentStartUrl: "https://mc.manuscriptcentral.com/kes",
    eicAssessmentSlowMo: "250",
    eicAssessmentRejectMessage: "Reviewed second-stage message",
    eicAssessmentKeepOpen: true,
  }, {
    run: "logs/eic-assessment/run.json",
    stage: "eic",
  }), [
    "--headed",
    "--assessment-stage=eic",
    "--from-run=logs/eic-assessment/run.json",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--slow-mo=250",
    "--screening-reject-message=Reviewed second-stage message",
    "--keep-open",
  ]);
});
