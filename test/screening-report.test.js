import test from "node:test";
import assert from "node:assert/strict";
import { formatTokenUsage, screeningResultToCsv } from "../src/screening-report.js";

test("writes a readable screening CSV with metadata, outcome and tokens", () => {
  const csv = screeningResultToCsv({
    manuscripts: [{
      metadata: {
        manuscriptId: "KES-26-0001",
        title: "Title, with comma",
        abstract: "First line\nSecond line",
      },
      assessment: {
        provider: "codex-cli",
        decision: "REJECT",
        reason: "Weak contribution",
        usage: { available: true, inputTokens: 100, totalTokens: 120 },
        outputPath: "/tmp/result.json",
        eventsPath: "/tmp/events.jsonl",
      },
      continuation: { action: "WOULD_STOP" },
    }],
  }, "run-1");

  assert.match(csv, /manuscriptId,title,abstract,decision/);
  assert.match(csv, /KES-26-0001,"Title, with comma","First line\nSecond line",REJECT/);
  assert.match(csv, /\/tmp\/events\.jsonl/);
});

test("formats aggregate token usage for terminal logs", () => {
  assert.equal(formatTokenUsage({
    llmCalls: 2,
    callsWithUsage: 2,
    inputTokens: 300,
    cachedInputTokens: 160,
    outputTokens: 50,
    reasoningOutputTokens: 15,
    totalTokens: 350,
  }), "wywołania=2, input=300, cache=160, output=50, reasoning=15, razem=350");
});
