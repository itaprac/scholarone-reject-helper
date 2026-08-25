import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listScreeningRuns, readScreeningRun } from "../src/screening-runs.js";

test("keeps initial and EIC assessment run lists separate", async () => {
  const logsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "scholarone-assessment-runs-"));
  const filename = "2026-08-25T08-00-00-000Z.json";

  try {
    await writeRun(path.join(logsDir, "screening", filename), "initial", "KES-26-0001");
    await writeRun(path.join(logsDir, "eic-assessment", filename), "eic", "KES-26-0002");

    const initial = await listScreeningRuns(logsDir);
    const eic = await listScreeningRuns(logsDir, { stage: "eic" });
    assert.equal(initial[0].stage, "initial");
    assert.equal(eic[0].stage, "eic");

    const eicRun = await readScreeningRun(logsDir, filename, { stage: "eic" });
    assert.equal(eicRun.manuscripts[0].manuscriptId, "KES-26-0002");
  } finally {
    await fsp.rm(logsDir, { recursive: true, force: true });
  }
});

async function writeRun(file, stage, manuscriptId) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({
    runId: path.basename(file, ".json"),
    createdAt: "2026-08-25T08:00:00.000Z",
    config: { assessmentStage: stage, applyAssessmentDecisions: false },
    result: {
      status: "assessment_batch_completed",
      summary: { approved: 1, rejected: 0 },
      manuscripts: [{
        metadata: { manuscriptId, title: "Title", abstract: "Abstract" },
        assessment: { decision: "APPROVE", reason: "Reason" },
      }],
    },
  }));
}
