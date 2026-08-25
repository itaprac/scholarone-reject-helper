import assert from "node:assert/strict";
import test from "node:test";
import { buildRunConfig } from "../src/config/run-config.js";
import {
  DEFAULT_ASSESSMENT_PROMPT,
  DEFAULT_EIC_ASSESSMENT_PROMPT,
} from "../src/default-assessment-prompt.js";
import { assessmentProgressPath } from "../src/assessment-stage.js";

const EMPTY_ENV = "/tmp/scholarone-reject-helper-missing-env";

test("EIC assessment uses its own queue and stricter default prompt", () => {
  const config = buildRunConfig(["--assessment-stage=eic"], { envFile: EMPTY_ENV });

  assert.equal(config.assessmentStage, "eic");
  assert.equal(config.assessmentQueueLabel, "Awaiting EIC Assignment");
  assert.equal(config.assessmentPrompt, DEFAULT_EIC_ASSESSMENT_PROMPT);
  assert.notEqual(config.assessmentPrompt, DEFAULT_ASSESSMENT_PROMPT);
  assert.match(assessmentProgressPath(config), /logs\/eic-assessment\/live\.progress\.json$/);
});

test("initial assessment keeps Complete Checklist and its original prompt", () => {
  const config = buildRunConfig([], { envFile: EMPTY_ENV });

  assert.equal(config.assessmentStage, "initial");
  assert.equal(config.assessmentQueueLabel, "Complete Checklist");
  assert.equal(config.assessmentPrompt, DEFAULT_ASSESSMENT_PROMPT);
});

test("EIC assessment cannot leave approvals awaiting editor assignment", () => {
  assert.throws(
    () => buildRunConfig([
      "--assessment-stage=eic",
      "--from-run=logs/eic-assessment/example.json",
      "--approve-without-assign",
    ], { envFile: EMPTY_ENV }),
    /nie działa w drugim etapie EIC assessment/
  );
});
