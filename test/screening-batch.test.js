import test from "node:test";
import assert from "node:assert/strict";
import { buildScreeningBatchResult } from "../src/screening-batch.js";

test("keeps every eligible manuscript and assessment in one batch result", () => {
  const result = buildScreeningBatchResult({
    checked: 3,
    skippedUnusualActivity: [{ manuscriptId: "KES-26-0001", reason: "alert" }],
    manuscripts: [
      {
        metadata: { manuscriptId: "KES-26-0002", title: "A", abstract: "Abstract A" },
        assessment: {
          provider: "codex-cli",
          decision: "APPROVE",
          durationMs: 1000,
          usage: {
            available: true,
            inputTokens: 100,
            cachedInputTokens: 60,
            uncachedInputTokens: 40,
            outputTokens: 20,
            reasoningOutputTokens: 5,
            totalTokens: 120,
          },
        },
        continuation: { action: "WOULD_CONTINUE" },
        assessmentError: null,
      },
      {
        metadata: { manuscriptId: "KES-26-0003", title: "B", abstract: "Abstract B" },
        assessment: {
          provider: "codex-cli",
          decision: "REJECT",
          durationMs: 2000,
          usage: {
            available: true,
            inputTokens: 200,
            cachedInputTokens: 100,
            uncachedInputTokens: 100,
            outputTokens: 30,
            reasoningOutputTokens: 10,
            totalTokens: 230,
          },
        },
        continuation: { action: "WOULD_STOP" },
        assessmentError: null,
      },
    ],
    assessWithLlm: true,
    scanAll: true,
    maxChecked: 10,
    queueExhausted: true,
  });

  assert.equal(result.status, "assessment_batch_completed");
  assert.equal(result.manuscripts.length, 2);
  assert.deepEqual(result.summary, {
    checked: 3,
    eligible: 2,
    skippedUnusualActivity: 1,
    approved: 1,
    rejected: 1,
    automaticallyApprovedRevisions: 0,
    assessmentErrors: 0,
    liveApproved: 0,
    liveRejected: 0,
    liveApprovedAwaitingAssignment: 0,
    liveAdvancedToReviewers: 0,
    actionErrors: 0,
    totalAssessmentDurationMs: 3000,
    tokenUsage: {
      llmCalls: 2,
      callsWithUsage: 2,
      inputTokens: 300,
      cachedInputTokens: 160,
      uncachedInputTokens: 140,
      outputTokens: 50,
      reasoningOutputTokens: 15,
      totalTokens: 350,
      averageTotalTokensPerCall: 175,
    },
  });
  assert.equal(result.queueExhausted, true);
  assert.equal(result.limitReached, false);
});

test("records LLM errors without dropping the rest of the batch", () => {
  const result = buildScreeningBatchResult({
    checked: 2,
    skippedUnusualActivity: [],
    manuscripts: [
      { assessment: { decision: "APPROVE" }, assessmentError: null },
      { assessment: null, assessmentError: { message: "timeout" } },
    ],
    assessWithLlm: true,
    scanAll: false,
    maxChecked: 2,
    queueExhausted: false,
  });

  assert.equal(result.status, "assessment_batch_completed_with_errors");
  assert.equal(result.summary.assessmentErrors, 1);
  assert.equal(result.limitReached, true);
});

test("reports revisions approved by the automatic rule", () => {
  const result = buildScreeningBatchResult({
    checked: 1,
    skippedUnusualActivity: [],
    manuscripts: [{
      assessment: { decision: "APPROVE", mode: "automatic-revision" },
      assessmentError: null,
    }],
    assessWithLlm: true,
    scanAll: true,
    maxChecked: 10,
    queueExhausted: true,
  });

  assert.equal(result.summary.approved, 1);
  assert.equal(result.summary.automaticallyApprovedRevisions, 1);
  assert.equal(result.summary.skippedUnusualActivity, 0);
});

test("reports completed live decisions and action failures separately", () => {
  const result = buildScreeningBatchResult({
    checked: 3,
    skippedUnusualActivity: [],
    manuscripts: [
      {
        assessment: { decision: "APPROVE" },
        decisionAction: { completed: true, decision: "APPROVE" },
      },
      {
        assessment: { decision: "REJECT" },
        decisionAction: { completed: true, decision: "REJECT" },
      },
      {
        assessment: { decision: "REJECT" },
        actionError: { message: "uncertain page" },
      },
    ],
    assessWithLlm: true,
    applyAssessmentDecisions: true,
    scanAll: true,
    maxChecked: 10,
    queueExhausted: false,
  });

  assert.equal(result.status, "assessment_batch_completed_with_errors");
  assert.equal(result.summary.liveApproved, 1);
  assert.equal(result.summary.liveRejected, 1);
  assert.equal(result.summary.liveApprovedAwaitingAssignment, 0);
  assert.equal(result.summary.actionErrors, 1);
  assert.match(result.note, /APPROVE 1, REJECT 1/);
});

test("counts approvals left awaiting manual editor assignment", () => {
  const result = buildScreeningBatchResult({
    checked: 2,
    skippedUnusualActivity: [],
    manuscripts: [
      {
        assessment: { decision: "APPROVE" },
        decisionAction: { completed: true, decision: "APPROVE", awaitingEditorAssignment: true },
      },
      {
        assessment: { decision: "APPROVE", mode: "automatic-revision" },
        decisionAction: { completed: true, decision: "APPROVE" },
      },
    ],
    assessWithLlm: true,
    applyAssessmentDecisions: true,
    scanAll: true,
    maxChecked: 10,
    queueExhausted: true,
  });

  assert.equal(result.summary.liveApproved, 2);
  assert.equal(result.summary.liveApprovedAwaitingAssignment, 1);
  assert.match(result.note, /1 zatwierdzonych czeka w Awaiting EIC Assignment/);
});

test("reports EIC assessment papers advanced to Assign Reviewers", () => {
  const result = buildScreeningBatchResult({
    checked: 2,
    skippedUnusualActivity: [],
    manuscripts: [
      {
        assessment: { decision: "APPROVE" },
        decisionAction: { completed: true, decision: "APPROVE", advancedToReviewers: true },
      },
      {
        assessment: { decision: "REJECT" },
        decisionAction: { completed: true, decision: "REJECT", advancedToReviewers: false },
      },
    ],
    assessWithLlm: true,
    applyAssessmentDecisions: true,
    scanAll: true,
    maxChecked: 10,
    queueExhausted: true,
    queueLabel: "Awaiting EIC Assignment",
    assessmentStage: "eic",
  });

  assert.equal(result.assessmentStage, "eic");
  assert.equal(result.queueLabel, "Awaiting EIC Assignment");
  assert.equal(result.summary.liveAdvancedToReviewers, 1);
  assert.match(result.note, /1 artykuł doprowadzono do etapu Assign Reviewers/);
});
