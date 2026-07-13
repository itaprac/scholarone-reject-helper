const args = process.argv.slice(2);

try {
  if (args.includes("--select-reviewers")) {
    const { runSelectReviewers } = await import("./select-reviewers.js");
    await runSelectReviewers(args);
  } else {
    await import("./auto-reject.js");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
