import test from "node:test";
import assert from "node:assert/strict";
import {
  canRecoverReviewerContext,
  findMatchingSimilarAccount,
  isReviewerCandidateSkipped,
  isReviewerSearchDeferredResult,
  rememberDeferredReviewer,
  reviewerQueueLabels,
  reviewersPendingInvitation,
} from "../src/select-reviewers.js";

test("combined reviewer mode drains Invite Reviewers before Select Reviewers", () => {
  assert.deepEqual(reviewerQueueLabels("combined"), ["Invite Reviewers", "Select Reviewers"]);
  assert.deepEqual(reviewerQueueLabels("invite"), ["Invite Reviewers"]);
  assert.deepEqual(reviewerQueueLabels("select"), ["Select Reviewers"]);
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
