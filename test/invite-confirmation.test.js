import test from "node:test";
import assert from "node:assert/strict";
import { confirmInvitationsSent } from "../src/select-reviewers.js";

test("confirms Invite All from a sufficient invited-counter increase", () => {
  const result = confirmInvitationsSent({
    beforeCounters: { invited: 3 },
    afterCounters: { invited: 5 },
    afterReviewers: [],
    expected: [
      { name: "Jan Kowalski", email: "jan@example.com" },
      { name: "Anna Nowak", email: "anna@example.com" },
    ],
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.invitedIncrease, 2);
});

test("confirms Invite All when every expected reviewer now has Invited status", () => {
  const result = confirmInvitationsSent({
    beforeCounters: null,
    afterCounters: null,
    afterReviewers: [
      { name: "Kowalski, Jan", email: "jan@example.com", status: "Invited", history: "Invited: today" },
    ],
    expected: [{ name: "Jan Kowalski", email: "jan@example.com" }],
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.confirmedExpected, 1);
});

test("does not treat popup completion alone as invitation confirmation", () => {
  const result = confirmInvitationsSent({
    beforeCounters: { invited: 3 },
    afterCounters: { invited: 3 },
    afterReviewers: [
      { name: "Kowalski, Jan", email: "jan@example.com", status: "Selected", history: "" },
    ],
    expected: [{ name: "Jan Kowalski", email: "jan@example.com" }],
  });
  assert.equal(result.confirmed, false);
});
