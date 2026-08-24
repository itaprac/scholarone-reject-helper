import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateAddConfirmationState,
  canRecoverReviewerContext,
  createMissingReviewerManuscriptSkipResult,
  createAccountBlockingReason,
  findMatchingSimilarAccount,
  isReviewerCandidateSkipped,
  isReviewerManuscriptSkippedResult,
  isReviewerSearchDeferredResult,
  isReviewerWaitingResult,
  isTargetManuscriptMissingError,
  rememberProcessedReviewerManuscript,
  rememberDeferredReviewer,
  reviewerArticleSkipReason,
  reviewerQueueLabels,
  reviewerSelectionPolicy,
  reviewersPendingInvitation,
} from "../src/select-reviewers.js";

test("combined reviewer mode drains Invite Reviewers before Assign/Select Reviewers", () => {
  assert.deepEqual(reviewerQueueLabels("combined"), ["Invite Reviewers", "Assign Reviewers", "Select Reviewers"]);
  assert.deepEqual(reviewerQueueLabels("invite"), ["Invite Reviewers"]);
  assert.deepEqual(reviewerQueueLabels("select"), ["Assign Reviewers", "Select Reviewers"]);
});

test("a reviewer run never processes the same finished manuscript twice", () => {
  const processed = new Set();
  assert.equal(rememberProcessedReviewerManuscript(processed, {
    status: "invite_all_confirmed",
    manuscript: { manuscriptId: "KES-26-0001" },
  }), true);
  assert.equal(rememberProcessedReviewerManuscript(processed, {
    status: "reviewer_search_deferred",
    manuscript: { manuscriptId: "KES-26-0002" },
  }), false);
  assert.deepEqual([...processed], ["KES-26-0001"]);
});

test("an unusual-activity alert skips reviewer handling before any invitation work", () => {
  assert.equal(
    reviewerArticleSkipReason("High rate of unusual activity on this document detected"),
    "unusual_activity_alert"
  );
  assert.equal(reviewerArticleSkipReason("Reviewer List"), null);
  assert.equal(isReviewerManuscriptSkippedResult({ status: "reviewer_manuscript_skipped" }), true);
});

test("a duplicate-people merge warning blocks this candidate instead of the batch", () => {
  assert.equal(createAccountBlockingReason(`
    Duplicate people in the system exist with this email address.
    Please use the user administration/merge tools to fix the accounts before proceeding.
  `), "duplicate_people_merge_required");
  assert.equal(createAccountBlockingReason(
    "A person with this e-mail address already exists in the system. Click Save and Add."
  ), null);
});

test("recovery follows an exact manuscript only before invitations are sent", () => {
  assert.equal(canRecoverReviewerContext({
    manuscriptId: "KES-26-0120",
    stage: "selecting_reviewers",
  }), true);
  assert.equal(canRecoverReviewerContext({
    manuscriptId: "KES-26-0120",
    stage: "opening_invite_popup",
  }), true);
  assert.equal(canRecoverReviewerContext({
    manuscriptId: "KES-26-0120",
    stage: "sending_invitations",
  }), false);
  assert.equal(canRecoverReviewerContext({
    manuscriptId: "KES-26-0120",
    stage: "verifying_invitations",
  }), false);
  assert.equal(canRecoverReviewerContext({ stage: "selecting_reviewers" }), false);
});

test("a manuscript missing after safe recovery is skipped and remains reportable", () => {
  const result = createMissingReviewerManuscriptSkipResult("KES-26-0934", "/tmp/reviewers.jsonl");
  assert.deepEqual(result, {
    status: "reviewer_manuscript_skipped",
    reason: "missing_after_safe_recovery",
    manuscript: { manuscriptId: "KES-26-0934" },
    logFile: "/tmp/reviewers.jsonl",
  });
  assert.equal(isReviewerManuscriptSkippedResult(result), true);
});

test("missing-target recovery recognizes every supported reviewer queue label", () => {
  for (const queueLabel of ["Invite Reviewers", "Assign Reviewers", "Select Reviewers"]) {
    assert.equal(isTargetManuscriptMissingError(
      new Error(`Nie znaleziono manuskryptu KES-26-0934 w kolejce ${queueLabel}.`)
    ), true);
  }
});

test("deferred reviewer searches remember one exact manuscript and update its retry", () => {
  const queue = [];
  const first = {
    status: "reviewer_search_deferred",
    manuscript: { manuscriptId: "KES-26-0116", title: "Example" },
    target: 10,
    countTowardTarget: 9,
    refreshRequested: true,
    reason: "candidate_pool_exhausted",
  };
  assert.equal(isReviewerSearchDeferredResult(first), true);
  rememberDeferredReviewer(queue, first, 1);
  rememberDeferredReviewer(queue, {
    ...first,
    countTowardTarget: 9,
    refreshRequested: false,
    reason: "not_visible_in_reviewer_queues",
  }, 1, 2);

  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0], {
    manuscriptId: "KES-26-0116",
    manuscript: { manuscriptId: "KES-26-0116", title: "Example" },
    batchIndex: 1,
    attempts: 2,
    countTowardTarget: 9,
    target: 10,
    refreshRequested: false,
    reason: "not_visible_in_reviewer_queues",
  });
});

test("invitation verification includes reviewers selected before a deferred retry", () => {
  const reviewers = [
    { name: "Previously Selected", status: "", history: "Selected: 13-Jul-2026" },
    { name: "Newly Selected", status: "Selected", history: "Selected: 13-Jul-2026" },
    { name: "Already Invited", status: "Invited", history: "Invited: 13-Jul-2026" },
    { name: "Declined", status: "Declined", history: "Declined: 13-Jul-2026" },
  ];
  assert.deepEqual(
    reviewersPendingInvitation(reviewers).map(({ name }) => name),
    ["Previously Selected", "Newly Selected"]
  );
});

test("an Assign Reviewers item with no selected reviewers is a safe waiting state", () => {
  const reviewers = [
    { name: "Already Invited", status: "Invited", history: "Invited: 11-Aug-2026" },
    { name: "Declined", status: "Declined invite again", history: "Declined: 09-Aug-2026" },
  ];
  assert.deepEqual(reviewersPendingInvitation(reviewers), []);
  assert.equal(isReviewerWaitingResult({ status: "reviewers_already_invited_waiting" }), true);
  assert.equal(isReviewerWaitingResult({ status: "invite_all_confirmed" }), false);
});

test("a revision invites its selected reviewers without adding new candidates", () => {
  assert.deepEqual(reviewerSelectionPolicy("KES-26-0116.R3", "Invite Reviewers", [
    { name: "Previously Selected", status: "Selected" },
    { name: "Prior Reviewer", status: "Agreed" },
  ]), {
    isRevision: true,
    isInviteQueue: true,
    addNewReviewers: false,
    reason: "revision_reuses_existing_reviewers",
  });
});

test("a revision may add candidates when a prior reviewer needs replacement", () => {
  assert.deepEqual(reviewerSelectionPolicy("KES-26-0116.R2", "Invite Reviewers", [
    { name: "Previously Selected", status: "Selected" },
    { name: "Prior Reviewer", status: "Declined" },
  ]), {
    isRevision: true,
    isInviteQueue: true,
    addNewReviewers: true,
    reason: "revision_has_reviewer_needing_replacement",
  });
});

test("an original submission still fills the configured reviewer target", () => {
  assert.deepEqual(reviewerSelectionPolicy("KES-26-0116", "Invite Reviewers", [
    { name: "Previously Selected", status: "Selected" },
  ]), {
    isRevision: false,
    isInviteQueue: true,
    addNewReviewers: true,
    reason: "original_submission_fills_reviewer_target",
  });
});

test("a revision reuses prior reviewers also in Assign/Select Reviewers", () => {
  assert.deepEqual(reviewerSelectionPolicy("KES-26-0116.R1", "Assign Reviewers", [
    { name: "Previously Selected", status: "Selected" },
  ]), {
    isRevision: true,
    isInviteQueue: false,
    addNewReviewers: false,
    reason: "revision_reuses_existing_reviewers",
  });
});

test("a revision in Assign Reviewers may replace a reviewer only after refusal", () => {
  assert.deepEqual(reviewerSelectionPolicy("KES-26-0116.R1", "Assign Reviewers", [
    { name: "Previously Selected", status: "Selected" },
    { name: "Prior Reviewer", status: "Declined" },
  ]), {
    isRevision: true,
    isInviteQueue: false,
    addNewReviewers: true,
    reason: "revision_has_reviewer_needing_replacement",
  });
});

test("a reviewer with only mismatched similar accounts is skipped safely", () => {
  const candidate = { name: "Yi Zhou", email: "yi.zhou@ibm.com" };
  const similarAccounts = [
    { name: "Yi Zhou", email: "yi.zhou@example.edu" },
    { name: "Zhou, Yiming", email: "yiming.zhou@ibm.com" },
  ];

  assert.equal(findMatchingSimilarAccount(candidate, similarAccounts), null);
  assert.equal(isReviewerCandidateSkipped({ code: "REVIEWER_CANDIDATE_SKIPPED" }), true);
});

test("an exact email among similar accounts remains eligible", () => {
  const candidate = { name: "Yi Zhou", email: "yi.zhou@ibm.com" };
  const exact = { id: "xik_exact", name: "Zhou, Yi", email: "yi.zhou@ibm.com" };
  assert.equal(findMatchingSimilarAccount(candidate, [
    { id: "xik_other", name: "Yi Zhou", email: "other@example.com" },
    exact,
  ]), exact);
});

test("a failed Add may be skipped only when the reviewer roster stayed unchanged", () => {
  const before = [
    { id: "reviewer-1", name: "Ganaa, Ernest", status: "Agreed" },
    { id: "reviewer-2", name: "Amer, Ali", status: "Selected" },
  ];
  assert.deepEqual(candidateAddConfirmationState(before, [
    { ...before[0], status: "Agreed" },
    { ...before[1], history: "Selected: 13-Jul-2026" },
  ]), {
    rosterUnchanged: true,
    beforeTotal: 2,
    afterTotal: 2,
    beforeCountTowardTarget: 2,
    afterCountTowardTarget: 2,
  });
});

test("an unrecognized roster change after Add remains a fatal ambiguity", () => {
  const before = [
    { id: "reviewer-1", name: "Ganaa, Ernest", status: "Agreed" },
    { id: "reviewer-2", name: "Amer, Ali", status: "Selected" },
  ];
  const result = candidateAddConfirmationState(before, [
    ...before,
    { id: "reviewer-3", name: "Unexpected Account", status: "Selected" },
  ]);
  assert.equal(result.rosterUnchanged, false);
  assert.equal(result.beforeTotal, 2);
  assert.equal(result.afterTotal, 3);
  assert.equal(result.afterCountTowardTarget, 3);
});
