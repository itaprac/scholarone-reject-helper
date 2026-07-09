import test from "node:test";
import assert from "node:assert/strict";
import { buildJobArgs } from "../src/job-args.js";

const OPTIONS = {
  startUrl: "https://mc.manuscriptcentral.com/kes",
  maxChecked: "50",
  submittedOlderThanDays: "30",
  queueStartPage: "2",
  maxRejected: "4",
  slowMo: "500",
  rejectMessage: "Message body",
  keepOpen: true,
};

test("builds the unchanged dry-run arguments in the original order", () => {
  assert.deepEqual(buildJobArgs("dryrun", OPTIONS), [
    "--headed",
    "--dry-run",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--max-checked=50",
    "--submitted-older-than-days=30",
    "--queue-start-page=2",
    "--slow-mo=500",
    "--keep-open",
  ]);
});

test("builds the unchanged live arguments in the original order", () => {
  assert.deepEqual(buildJobArgs("live", OPTIONS), [
    "--headed",
    "--save-and-send",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--max-checked=50",
    "--submitted-older-than-days=30",
    "--queue-start-page=2",
    "--max-rejected=4",
    "--slow-mo=500",
    "--reject-message=Message body",
    "--keep-open",
  ]);
});

test("builds the unchanged report arguments in the original order", () => {
  assert.deepEqual(buildJobArgs("send-from-report", OPTIONS, {
    report: "logs/reports/example.json",
  }), [
    "--headed",
    "--save-and-send",
    "--require-targets",
    "--reject-from-report=logs/reports/example.json",
    "--start-url=https://mc.manuscriptcentral.com/kes",
    "--submitted-older-than-days=30",
    "--max-rejected=4",
    "--slow-mo=500",
    "--reject-message=Message body",
    "--keep-open",
  ]);
});

test("keeps optional empty values out of the argument list", () => {
  assert.deepEqual(buildJobArgs("live", {
    maxChecked: "10",
    queueStartPage: "",
    maxRejected: "",
    keepOpen: false,
  }), [
    "--headed",
    "--save-and-send",
    "--max-checked=10",
  ]);
});
