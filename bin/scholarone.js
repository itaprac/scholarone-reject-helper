#!/usr/bin/env node
// Jedyny punkt wejścia automatu. Nic tu nie liczy i nic nie klika — wybiera
// tryb i przekazuje sterowanie do właściwego modułu.
const args = process.argv.slice(2);

try {
  if (args.includes("--select-reviewers")) {
    const { runSelectReviewers } = await import("../src/select-reviewers.js");
    await runSelectReviewers(args);
  } else {
    const { runReject } = await import("../src/run-reject.js");
    await runReject(args);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
