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
