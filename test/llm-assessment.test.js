import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssessmentPrompt,
  deriveSimulatedContinuation,
  parseAssessmentOutput,
  parseCodexJsonlTrace,
} from "../src/llm-assessment.js";
import {
  DEFAULT_ASSESSMENT_MODEL,
  DEFAULT_ASSESSMENT_REASONING_EFFORT,
  normalizeAssessmentReasoningEffort,
} from "../src/assessment-config.js";

const METADATA = {
  manuscriptId: "KES-26-0001",
  title: "A test manuscript",
  abstract: "This abstract is supplied only to verify the Codex connection.",
};

test("builds a real assessment prompt with untrusted manuscript data", () => {
  const prompt = buildAssessmentPrompt(METADATA, {
    instructions: "Strict assessment instructions",
  });

  assert.match(prompt, /^Strict assessment instructions/);
  assert.match(prompt, /Oceń artykuł zgodnie z powyższymi regułami/i);
  assert.doesNotMatch(prompt, /losowo|expectedDecision|TEST CONTRACT/i);
  assert.match(prompt, /Manuscript ID: KES-26-0001/);
  assert.match(prompt, /Title: A test manuscript/);
  assert.match(prompt, /This abstract is supplied/);
  assert.match(prompt, /UNTRUSTED/);
});

test("accepts only strict APPROVE or REJECT output", () => {
  assert.deepEqual(parseAssessmentOutput(JSON.stringify({
    decision: "approve",
    reason: "  Metadata received.  ",
  })), {
    decision: "APPROVE",
    reason: "Metadata received.",
  });

  assert.throws(() => parseAssessmentOutput("not json"), /niepoprawny JSON/);
  assert.throws(
    () => parseAssessmentOutput('{"decision":"MAYBE","reason":"x"}'),
    /APPROVE albo REJECT/
  );
});

test("maps LLM output to a simulated continuation without a ScholarOne action", () => {
  assert.deepEqual(deriveSimulatedContinuation("APPROVE"), {
    allowed: true,
    action: "WOULD_CONTINUE",
    note: "Symulacja: przyszły workflow mógłby przejść do Complete Checklist.",
  });
  assert.deepEqual(deriveSimulatedContinuation("REJECT"), {
    allowed: false,
    action: "WOULD_STOP",
    note: "Symulacja: przyszły workflow zatrzymałby się przed Complete Checklist.",
  });
});

test("uses Terra with medium reasoning as the assessment default", () => {
  assert.equal(DEFAULT_ASSESSMENT_MODEL, "gpt-5.6-terra");
  assert.equal(DEFAULT_ASSESSMENT_REASONING_EFFORT, "medium");
  assert.equal(normalizeAssessmentReasoningEffort(undefined), "medium");
  assert.throws(() => normalizeAssessmentReasoningEffort("extreme"), /low, medium, high/);
});

test("parses exact Codex token usage without counting cache or reasoning twice", () => {
  const trace = parseCodexJsonlTrace([
    '{"type":"thread.started","thread_id":"thread-123"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":13137,"cached_input_tokens":9984,"output_tokens":25,"reasoning_output_tokens":20}}',
  ].join("\n"));

  assert.equal(trace.threadId, "thread-123");
  assert.equal(trace.eventCount, 4);
  assert.deepEqual(trace.usage, {
    available: true,
    inputTokens: 13137,
    cachedInputTokens: 9984,
    uncachedInputTokens: 3153,
    outputTokens: 25,
    reasoningOutputTokens: 20,
    totalTokens: 13162,
  });
});
