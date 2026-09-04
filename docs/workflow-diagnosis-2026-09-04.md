# Workflow failure diagnosis, 4 September 2026

The review covered 96 local run logs from 10 August to 4 September 2026,
the current source, existing changes in the working tree, and the latest EIC
failure screenshot. The logs contain 52 `run_failed` events. They also contain
9 `assessment_live_action_failed`, 2 `screening_from_run_action_failed`,
5 `reject_step_failed`, and 1 `save_send_failed` events. These are event
counts, not separate counts of affected manuscripts.

Some failed actions ended with `run_finished` and process exit code 0.
The number of failed processes therefore did not show all workflow failures.

## Repairs verified offline

| Defect | Evidence and reproduction | Change |
|---|---|---|
| The next step ran on the previous document | A delayed POST test showed that the navigation helper returned before the response. The latest EIC screenshot showed the dashboard after the log claimed to open Select Reviewers. | Text and image form submissions now wait for the navigation that they start. A test covers the dashboard and a same-name manuscript tab. |
| EIC page changes could return to the starting queue | A two-page test configured Awaiting EIC Assignment as the starting queue and searched Select Reviewers. It failed after the first page. | The target queue travels with the page request, including recovery after login. Queue page changes verify the returned page number. |
| ID lookup accepted prefixes | A test opened a revision or a longer ID when searching for the original manuscript. | Both saved-decision lookup and Immediate Decision lookup require the complete ID. |
| Empty queues appeared to have missing controls | A queue with an explicit empty message failed the readiness test. | Empty messages and zero counters are accepted. The scan does not open rows from another queue when the requested queue is empty. |
| Complete reviewer rosters appeared incomplete | A two-record test with the same name reported two rows from the server but only one row from the reader. | Roster completeness uses record IDs. Name matching remains available when IDs are missing. |
| Reviewer range text came from an unselected option | A test returned 51–51 while the selected option and the rows were 1–50. Historical logs have this range/row mismatch. | The reader uses the selected range. It waits for the reviewer list before reading pagination. |
| A failed page request stopped reviewer selection immediately | A routed test returned the old page once, then the requested page. | Read-only pagination permits two attempts and requires a new document with the requested selection. Tests cover recovery, a persistent failure, a complete multi-page read, and an incomplete roster. |
| Save and Send was checked before its toolbar was ready | A delayed toolbar test returned no control; another selected a hidden control in the parent frame. | The send step waits up to 10 seconds for a visible control across frames. The click itself is not retried. |
| Action failures were reported as successful runs | A final result with an action error produced status `finished`. | Failed results now set process exit code 1 and a failed final event. The status file retains the workflow result. Normal limits and expected skips remain successful. |

The tests first reproduced the defects before the fixes. The pagination retry
test reproduces the reported timeout pattern, but it does not establish why
the remote server returned an unexpected page in every historical incident.
No complete production EIC rejection was executed during this review.

## Existing repairs and unresolved evidence

Changes already present at the start covered reviewer recovery when a target
leaves a queue, missing or stalled Create Account popups, restoration of the
previous reviewer page, and the EIC route through Select Reviewers. Those
changes were preserved. This review added tests and fixed defects around them.

The largest historical `run_failed` groups were:

| Failure | Events | Current assessment |
|---|---:|---|
| Reviewer pagination timeout | 14 | Range parsing and bounded page retry are repaired. The remote cause of each timeout remains unverified. |
| Manuscript missing from Assign Reviewers | 12 | Existing recovery checks other supported queues and can report a missing target as a skip. |
| Missing View Details controls | 8 | Navigation and empty-queue defects are repaired. Not every historical page was retained. |
| Missing first Invite All control | 7 | Existing readiness and invitation tests pass. The old failure pages are not available for a complete replay. |
| Missing Create Account popup | 5 | Existing roster verification and popup recovery tests pass. |

Other logs include a closed page/browser, a blank reviewer page, an admin page
that did not load, and a missing Reject control. The available artifacts do
not establish a distinct cause for each event. They must not all be described
as fixed by a longer timeout.

## Incomplete EIC actions

The EIC progress file contains nine `attempted` REJECT actions. The initial
screening progress file has no `attempted` entries. No progress records were
reset or rewritten.

The local recovery list is in
`logs/workflow-recovery-2026-09-04.md`. It is excluded from Git with the rest
of `logs/`. It lists manuscript IDs, run IDs, and the recorded failure.
Check the current status, editor assignments, decision history, and outgoing
correspondence in ScholarOne before retrying any of those actions. The
application still blocks automatic retries of unconfirmed decisions.

## Validation

`npm run check` passed with 257 passing tests, zero failures, three skipped
tests due to missing snapshots, and two existing TODO tests. The baseline
had 239 passing tests. ESLint still reports existing unused-import warnings.
`git diff --check` passed.

The full test run also found a timing-dependent log-retention test. Its files
could have equal modification timestamps. The test now uses distinct ages;
the production retention rules were not changed.

Browser tests used synthetic pages, local fixtures, and intercepted requests
to `scholarone.test`. They sent no messages and performed no editorial
actions in ScholarOne. New workflow processes load the repaired source.
