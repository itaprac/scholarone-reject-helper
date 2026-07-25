import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSESSMENT_PROMPT_VARIANTS,
  getAssessmentPromptVariant,
} from "../src/assessment-prompt-variants.js";
import { DEFAULT_ASSESSMENT_PROMPT } from "../src/default-assessment-prompt.js";

test("assessment prompt variants have stable unique keys and evidence-based rules", () => {
  assert.equal(ASSESSMENT_PROMPT_VARIANTS.length, 9);
  assert.equal(new Set(ASSESSMENT_PROMPT_VARIANTS.map((variant) => variant.key)).size, 9);
  for (const variant of ASSESSMENT_PROMPT_VARIANTS) {
    assert.match(variant.prompt, /APPROVE/);
    assert.match(variant.prompt, /REJECT/);
    assert.ok(variant.prompt.length > 500);
  }
  assert.equal(getAssessmentPromptVariant("evidence_gate").key, "evidence_gate");
  assert.equal(getAssessmentPromptVariant("weighted_probability_40").prompt, DEFAULT_ASSESSMENT_PROMPT);
  assert.match(DEFAULT_ASSESSMENT_PROMPT, /greater than 40%/);
  assert.throws(() => getAssessmentPromptVariant("missing"), /Nieznany wariant/);
});
