import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunStatus, workflowResultFailed } from "../src/core/run-status.js";

async function makeStatus() {
  const logsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "run-status-"));
  const runStatus = createRunStatus({
    logsDir,
    runId: "2026-08-10T10-00-00-000Z",
    pid: 12345,
    mode: "reject-dryrun",
    logFile: "logs/2026-08-10T10-00-00-000Z.jsonl",
  });
  const read = async () =>
    JSON.parse(await fsp.readFile(path.join(logsDir, "current-run.json"), "utf8"));
  return { runStatus, read };
}

test("zapisuje puls z metadanymi od pierwszego zdarzenia", async () => {
  const { runStatus, read } = await makeStatus();
  await runStatus("run_prepared", {});

  const status = await read();
  assert.equal(status.status, "running");
  assert.equal(status.pid, 12345);
  assert.equal(status.mode, "reject-dryrun");
  assert.equal(status.logFile, "logs/2026-08-10T10-00-00-000Z.jsonl");
  assert.equal(status.lastEvent.type, "run_prepared");
});

test("liczniki rosną z rowIndex, checked i rejected", async () => {
  const { runStatus, read } = await makeStatus();
  await runStatus("manuscript_checked", { rowIndex: 4, manuscriptId: "KES-26-0117" });
  await runStatus("candidate_rejected_and_sent", { rowIndex: 4, rejected: 2 });
  await runStatus("manuscript_checked", { rowIndex: 1 });

  const status = await read();
  assert.equal(status.checked, 5);
  assert.equal(status.rejected, 2);
  assert.equal(status.lastEvent.type, "manuscript_checked");
});

test("run_finished zamyka przebieg z wynikiem", async () => {
  const { runStatus, read } = await makeStatus();
  await runStatus("run_finished", { status: "dry_run_finished", checked: 7 });

  const status = await read();
  assert.equal(status.status, "finished");
  assert.equal(status.resultStatus, "dry_run_finished");
  assert.equal(status.checked, 7);
  assert.ok(status.finishedAt);
});

test("run_failed oznacza przebieg jako nieudany", async () => {
  const { runStatus, read } = await makeStatus();
  await runStatus("run_failed", { message: "boom" });

  const status = await read();
  assert.equal(status.status, "failed");
  assert.equal(status.lastEvent.note, "boom");
});

test("a completed process with failed live actions is not a successful run", async () => {
  const { runStatus, read } = await makeStatus();
  await runStatus("run_finished", {
    status: "assessment_batch_completed_with_errors",
    summary: { actionErrors: 1 },
  });
  assert.equal((await read()).status, "failed");
  assert.equal((await read()).resultStatus, "assessment_batch_completed_with_errors");
});

test("a failed final event retains the workflow result for diagnosis", async () => {
  const { runStatus, read } = await makeStatus();
  await runStatus("run_failed", { status: "action_failed", note: "Action not confirmed" });
  assert.equal((await read()).resultStatus, "action_failed");
});

test("distinguishes workflow failures from normal limits and skipped manuscripts", () => {
  assert.equal(workflowResultFailed({ status: "action_failed" }), true);
  assert.equal(workflowResultFailed({ status: "needs_manual_review" }), true);
  assert.equal(workflowResultFailed({ status: "search_reject_finished", results: [{ status: "save_send_failed" }] }), true);
  assert.equal(workflowResultFailed({ status: "max_live_actions_reached" }), false);
  assert.equal(workflowResultFailed({ status: "screening_from_run_finished", results: [{ status: "not_found_in_queue" }] }), false);
});

test("awaria zapisu nie wybucha", async () => {
  const runStatus = createRunStatus({
    logsDir: "/dev/null/nope",
    runId: "x",
    pid: 1,
    mode: "scan",
    logFile: "logs/x.jsonl",
  });
  await assert.doesNotReject(runStatus("run_prepared", {}));
});
