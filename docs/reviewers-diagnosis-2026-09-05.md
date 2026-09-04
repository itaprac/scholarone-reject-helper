# Reviewer workflow diagnosis — 2026-09-05

## Scope

Reviewed the reviewer queue, candidate addition, roster pagination, invitation
popup, confirmation, and deferred search paths. Timing analysis used 47 local
reviewer JSONL logs. Browser tests used synthetic pages and intercepted network
requests. No invitations were sent to real people and no production workflow
was started for this review.

## Findings and changes

- An empty queue on the first iteration was reported as a failed run. It now
  completes with zero processed manuscripts. Selection checks both queue names,
  `Assign Reviewers` and `Select Reviewers`, before treating the queue as empty.
- Substring matching could confuse an original manuscript with its revision.
  Queue selection and quick search now require an exact manuscript ID. The
  opened article must also match the selected queue entry before any candidate
  is added or invitation is sent.
- The first invitation control could appear after the article content. The
  workflow now waits for the control before checking that it is unique.
- Final invitation submission waited for both popup closure and navigation.
  A popup that navigated but stayed open could consume the closure timeout.
  The workflow now continues after either event and checks the article for
  confirmation. Neither event alone confirms delivery.
- A single immediate read could report failure before invitation statuses
  updated. Confirmation now polls counters, with full roster checks at intervals,
  during a verification window. This path does not click Send again.
- A missing initial invitation counter was treated as zero. Existing invitations
  could then appear to be new. Counter confirmation now requires valid values
  from before and after submission.
- Matching by name could use one roster record to confirm multiple people, or
  hide a changed record with the same name. Roster comparison and invitation
  status confirmation now match records one to one and use exact record IDs
  when both sides have them.
- Repeated full roster reads returned to the original page even when the next
  step did not need it. Workflow reads now start on the current page and omit
  that return request. All roster pages and completeness checks remain required.
- Deferred searches waited the full configured interval again, even when the
  search had already been running while other manuscripts were processed. The
  wait now subtracts elapsed time since deferral.
- The final unsuccessful candidate verification read no longer adds a sleep
  after the last attempt. The earlier verification attempts remain in place.

## Timing evidence

Historical event intervals across the 47 logs included:

| Event interval | Count | Total time | Median |
| --- | ---: | ---: | ---: |
| Candidate Add start to missing popup | 1,118 | 16,773.6 s | 15.0 s |
| Consecutive roster page reads | 5,671 | 8,686.7 s | 1.52 s |
| Candidate confirmation refresh | 2,202 | 4,748.0 s | 1.89 s |

These are historical event intervals, not isolated CPU measurements or a
prediction for the next batch. The earlier repair already stops selection after
three consecutive Add attempts that produce no confirmed roster change, instead
of trying the entire candidate pool. This review retains that guard and does
not shorten popup waits based only on elapsed time.

In a controlled test, six complete reads of a two-page roster used 12 requests
before the optimization and 6 after it. With a simulated 100 ms response delay,
the measured time fell from 1,544 ms to 794 ms, about 49%. Each read still checked
both records. The request reduction is the test assertion; elapsed time is a
diagnostic measurement and varies with machine load. This is a gain for roster
reads, not a measured 49% reduction for an entire live batch.

## Regression coverage

Tests cover empty startup, exact manuscript and revision matching, refusal to
process an unexpected article, missing counters, duplicate-name records, delayed
invitation controls, popup reuse, navigation without closure, deferred wait
accounting, and complete paginated reads. Two browser tests run from the queue
through invitation confirmation: one with an existing reviewer and one with a
new candidate. Both delay the article status update and assert exactly one
submission. Another test verifies that an unchanged roster remains unconfirmed.

Final validation: `npm run check` passed. The test suite reported 277 tests:
272 passed, zero failed, three skipped, and two TODO entries. ESLint reported
warnings but no errors. `git diff --check` also passed.

Live latency, server-side failures, and future ScholarOne markup changes remain
outside the evidence from these offline tests.
