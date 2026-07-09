export function inspectManuscriptText(
  bodyText,
  { submittedOlderThanDays, now = null }
) {
  const manuscriptId = extractManuscriptId(bodyText);
  const submittedDate = extractSubmittedDate(bodyText);
  const hasUnusualActivity = /high\s+rate\s+of\s+unusual\s+activity/i.test(bodyText);
  const isRevision = manuscriptId ? /\.R\d+$/i.test(manuscriptId) : false;

  if (!manuscriptId) {
    return {
      action: "manual_review",
      reason: "Nie udalo sie odczytac Manuscript ID.",
      manuscriptId: null,
      submittedDate: submittedDate ? submittedDate.toISOString() : null,
      hasUnusualActivity,
      isRevision,
    };
  }

  if (isRevision) {
    return {
      action: "skip",
      reason: "Manuscript ID jest rewizja (.R + liczba).",
      manuscriptId,
      submittedDate: submittedDate ? submittedDate.toISOString() : null,
      hasUnusualActivity,
      isRevision,
    };
  }

  const submittedMoreThanLimit =
    submittedDate &&
    daysBetweenUtcMidnights(submittedDate, now || new Date()) > submittedOlderThanDays;

  if (hasUnusualActivity || submittedMoreThanLimit) {
    const reasons = [];
    if (hasUnusualActivity) {
      reasons.push("ma komunikat High rate of unusual activity");
    }
    if (submittedMoreThanLimit) {
      reasons.push(`Date submitted jest starsze niz ${submittedOlderThanDays} dni`);
    }

    return {
      action: "candidate",
      reason: reasons.join("; "),
      manuscriptId,
      submittedDate: submittedDate ? submittedDate.toISOString() : null,
      hasUnusualActivity,
      isRevision,
      submittedMoreThanLimit,
    };
  }

  return {
    action: "skip",
    reason: "Brak rewizji .R + liczba, ale nie ma unusual activity ani daty starszej niz limit.",
    manuscriptId,
    submittedDate: submittedDate ? submittedDate.toISOString() : null,
    hasUnusualActivity,
    isRevision,
    submittedMoreThanLimit,
  };
}

export function extractManuscriptId(text) {
  const labeled = text.match(/(?:manuscript|submission|document)\s*(?:id|number)?\s*[:#]?\s*([A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?)/i);
  if (labeled) {
    return labeled[1].toUpperCase();
  }

  const generic = text.match(/\b([A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?)\b/i);
  return generic ? generic[1].toUpperCase() : null;
}

export function normalizeManuscriptId(value) {
  return (value || "").toUpperCase().replace(/\s+/g, "").trim();
}

export function extractSubmittedDate(text) {
  const patterns = [
    /date\s+submitted\s*:?\s*([0-9]{1,2}[\s-]+[A-Z][a-z]{2,8}[\s-]+[0-9]{4})/i,
    /submitted\s+date\s*:?\s*([0-9]{1,2}[\s-]+[A-Z][a-z]{2,8}[\s-]+[0-9]{4})/i,
    /submitted\s*:?\s*([0-9]{1,2}[\s-]+[A-Z][a-z]{2,8}[\s-]+[0-9]{4})/i,
    /date\s+submitted\s*:?\s*([A-Z][a-z]{2,8}[\s-]+[0-9]{1,2},?[\s-]+[0-9]{4})/i,
    /submitted\s+date\s*:?\s*([A-Z][a-z]{2,8}[\s-]+[0-9]{1,2},?[\s-]+[0-9]{4})/i,
    /submitted\s*:?\s*([A-Z][a-z]{2,8}[\s-]+[0-9]{1,2},?[\s-]+[0-9]{4})/i,
    /date\s+submitted\s*:?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})/i,
    /submitted\s+date\s*:?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})/i,
    /submitted\s*:?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4})/i,
    /date\s+submitted\s*:?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
    /submitted\s+date\s*:?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
    /submitted\s*:?\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }

    const parsed = parseDateLoose(match[1]);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

export function parseDateLoose(value) {
  const normalized = value
    .replace(/,/g, "")
    .replace(/(\d{1,2})-([A-Za-z]{3,9})-(\d{2,4})/g, "$1 $2 $3")
    .replace(/([A-Za-z]{3,9})-(\d{1,2})-(\d{2,4})/g, "$1 $2 $3")
    .trim();
  const direct = new Date(normalized);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const slash = normalized.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    const year = normalizeYear(Number(slash[3]));

    const candidates = [
      new Date(Date.UTC(year, first - 1, second)),
      new Date(Date.UTC(year, second - 1, first)),
    ];

    return candidates.find((candidate) => !Number.isNaN(candidate.getTime())) || null;
  }

  return null;
}

function normalizeYear(year) {
  if (year < 100) {
    return year + 2000;
  }
  return year;
}

function daysBetweenUtcMidnights(olderDate, newerDate) {
  const older = Date.UTC(
    olderDate.getUTCFullYear(),
    olderDate.getUTCMonth(),
    olderDate.getUTCDate()
  );
  const newer = Date.UTC(
    newerDate.getUTCFullYear(),
    newerDate.getUTCMonth(),
    newerDate.getUTCDate()
  );
  return Math.floor((newer - older) / 86_400_000);
}
