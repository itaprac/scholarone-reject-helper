const OPTION_MAPPINGS = {
  dryrun: {
    "start-url": "startUrl",
    "max-checked": "maxChecked",
    "submitted-older-than-days": "submittedOlderThanDays",
    "queue-start-page": "queueStartPage",
    "slow-mo": "slowMo",
  },
  live: {
    "start-url": "startUrl",
    "max-checked": "maxChecked",
    "submitted-older-than-days": "submittedOlderThanDays",
    "queue-start-page": "queueStartPage",
    "max-rejected": "maxRejected",
    "slow-mo": "slowMo",
    "reject-message": "rejectMessage",
  },
  "send-from-report": {
    "start-url": "startUrl",
    "submitted-older-than-days": "submittedOlderThanDays",
    "max-rejected": "maxRejected",
    "slow-mo": "slowMo",
    "reject-message": "rejectMessage",
  },
};

export function buildJobArgs(mode, body, { report = "" } = {}) {
  const mapping = OPTION_MAPPINGS[mode];
  if (!mapping) {
    throw new Error(`Nieznany tryb uruchomienia: ${mode}`);
  }

  const args = ["--headed"];
  if (mode === "dryrun") {
    args.push("--dry-run");
  } else {
    args.push("--save-and-send");
  }

  if (mode === "send-from-report") {
    if (!report) {
      throw new Error("Tryb send-from-report wymaga raportu.");
    }
    args.push("--require-targets", `--reject-from-report=${report}`);
  }

  args.push(...optionArgs(body, mapping));
  if (body.keepOpen) {
    args.push("--keep-open");
  }
  return args;
}

export function buildReviewerJobArgs(mode, body) {
  if (!["reviewers-prepare", "reviewers-invite"].includes(mode)) {
    throw new Error(`Nieznany tryb reviewerów: ${mode}`);
  }

  const args = ["--select-reviewers", "--headed"];
  args.push(`--reviewer-queue=${body.reviewerQueue}`);
  if (mode === "reviewers-invite") {
    args.push("--invite-all");
  }

  args.push(...optionArgs(body, {
    "start-url": "reviewerStartUrl",
    "reviewers-per-paper": "reviewersPerPaper",
    "max-manuscripts": "reviewerMaxManuscripts",
    "slow-mo": "reviewerSlowMo",
    "refresh-wait-seconds": "reviewerRefreshWaitSeconds",
  }));
  if (body.reviewerKeepOpen) {
    args.push("--keep-open");
  }
  return args;
}

export function buildScreeningJobArgs(body, { applyDecisions = false } = {}) {
  const args = ["--headed", "--collect-metadata", "--assess-with-llm"];
  if (applyDecisions) {
    args.push("--apply-assessment-decisions");
  }
  if (body.screeningScanAll) {
    args.push("--scan-all-metadata");
  }
  args.push(...optionArgs(body, {
    "start-url": "screeningStartUrl",
    "max-checked": "screeningMaxChecked",
    "slow-mo": "screeningSlowMo",
    "assessment-model": "assessmentModel",
    "assessment-reasoning-effort": "assessmentReasoningEffort",
    "assessment-timeout-seconds": "assessmentTimeoutSeconds",
    "assessment-prompt": "assessmentPrompt",
  }));
  if (applyDecisions) {
    args.push(...optionArgs(body, {
      "screening-reject-message": "screeningRejectMessage",
    }));
  }
  if (body.screeningKeepOpen) {
    args.push("--keep-open");
  }
  return args;
}

function optionArgs(body, mapping) {
  const args = [];
  for (const [flag, key] of Object.entries(mapping)) {
    const value = body[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    args.push(`--${flag}=${value}`);
  }
  return args;
}
