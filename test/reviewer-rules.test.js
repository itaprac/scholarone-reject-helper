import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyReviewerStatus,
  countReviewersTowardTarget,
  normalizeName,
  parseListRange,
  samePerson,
  selectUniqueCandidates,
} from "../src/reviewer-rules.js";

test("normalizes punctuation, spaces, hyphens, case, and diacritics in names", () => {
  assert.equal(normalizeName("  ŚNIEGOWSKI,  Szymon-J. "), "sniegowski szymon j");
});

test("matches a swapped first and last name without matching one shared component", () => {
  assert.equal(samePerson({ name: "Jan Kowalski" }, { name: "Kowalski, Jan" }), true);
  assert.equal(samePerson({ name: "Jan Kowalski" }, { name: "Anna Kowalski" }), false);
});

test("matches names across diacritics", () => {
  assert.equal(samePerson({ name: "Bartłomiej Kizielewicz" }, { name: "Kizielewicz, Bartlomiej" }), true);
});

test("uses email as the strongest key", () => {
  assert.equal(samePerson(
    { name: "Jan Kowalski", email: " Reviewer@Example.COM " },
    { name: "Completely Different", email: "reviewer@example.com" }
  ), true);
  assert.equal(samePerson(
    { name: "Jan Kowalski", email: "first@example.com" },
    { name: "Kowalski, Jan", email: "second@example.com" }
  ), false);
});

test("classifies Agreed, Declined, Overdue, and Invite for target counting", () => {
  const reviewers = [
    { name: "One", status: "Agreed", history: "Agreed: 01-Jul-2026" },
    { name: "Two", status: "Agreed", history: "Overdue Time in Review: 30 Days" },
    { name: "Three", status: "Declined", history: "Declined: 02-Jul-2026" },
    { name: "Four", status: "Invite", history: "Declined: 01-Jun-2026" },
    { name: "Five", status: "Selected", history: "" },
    { name: "Six", status: "Auto-Declined invite again", history: "Invited: 01-Jun-2026" },
    { name: "Seven", status: "Unavailable invite again", history: "Invited: 01-Jun-2026" },
    { name: "Eight", status: "", history: "Selected: 13-Jul-2026 view full history" },
  ];

  assert.deepEqual(reviewers.map(classifyReviewerStatus).map(({ status, overdue }) => ({ status, overdue })), [
    { status: "agreed", overdue: false },
    { status: "agreed", overdue: true },
    { status: "declined", overdue: false },
    { status: "invite", overdue: false },
    { status: "selected", overdue: false },
    { status: "auto-declined", overdue: false },
    { status: "unavailable", overdue: false },
    { status: "selected", overdue: false },
  ]);
  assert.equal(countReviewersTowardTarget(reviewers), 4);
});

test("counts ScholarOne selections stored only in History", () => {
  const reviewer = {
    name: "Wang, Zhifeng",
    status: "",
    history: "Selected: 13-Jul-2026 view full history",
  };

  assert.deepEqual(classifyReviewerStatus(reviewer), {
    status: "selected",
    overdue: false,
    text: "Selected: 13-Jul-2026 view full history",
  });
  assert.equal(countReviewersTowardTarget([reviewer]), 1);
});

test("treats the empty 0-0 of 0 range as valid", () => {
  assert.deepEqual(parseListRange("Reviewer List 0-0 of 0"), {
    start: 0,
    end: 0,
    total: 0,
    empty: true,
  });
});

test("selects at most 10 unique candidates and excludes every prior reviewer", () => {
  const candidates = [
    { name: "Kowalski, Jan", email: "jan@example.com" },
    { name: "Anna Nowak", email: "anna@example.com" },
    { name: "Nowak, Anna", email: "anna@example.com" },
    ...Array.from({ length: 15 }, (_, index) => ({
      name: `Unique Person ${index}`,
      email: `unique-${index}@example.com`,
    })),
  ];
  const selected = selectUniqueCandidates(candidates, [
    { name: "Jan Kowalski", email: "jan@example.com" },
  ], 10);

  assert.equal(selected.length, 10);
  assert.equal(selected.some(({ email }) => email === "jan@example.com"), false);
  assert.equal(selected.filter(({ email }) => email === "anna@example.com").length, 1);
});
