export function normalizeEmail(value) {
  return String(value || "").trim().toLocaleLowerCase("en-US");
}

export function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[łøđðþæœß]/g, (character) => ({
      ł: "l",
      ø: "o",
      đ: "d",
      ð: "d",
      þ: "th",
      æ: "ae",
      œ: "oe",
      ß: "ss",
    })[character])
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function nameTokens(value) {
  const normalized = normalizeName(value);
  return normalized ? normalized.split(" ").sort() : [];
}

export function samePerson(left, right) {
  const leftEmail = normalizeEmail(left?.email);
  const rightEmail = normalizeEmail(right?.email);

  if (leftEmail && rightEmail) {
    return leftEmail === rightEmail;
  }

  const leftTokens = nameTokens(left?.name);
  const rightTokens = nameTokens(right?.name);
  if (leftTokens.length < 2 || rightTokens.length < 2) {
    return false;
  }

  return leftTokens.length === rightTokens.length &&
    leftTokens.every((token, index) => token === rightTokens[index]);
}

export function parseListRange(value) {
  const match = String(value || "").match(/(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return {
    start,
    end,
    total,
    empty: start === 0 && end === 0 && total === 0,
  };
}

export function classifyReviewerStatus(reviewer) {
  const current = String(reviewer?.status || "").replace(/\s+/g, " ").trim();
  const history = String(reviewer?.history || "").replace(/\s+/g, " ").trim();
  const text = [current, history]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const overdue = /\boverdue\b/i.test(text);

  let status = "other";
  if (/^selected\b/i.test(current)) {
    status = "selected";
  } else if (/^invited\b/i.test(current)) {
    status = "invited";
  } else if (/^invite\b/i.test(current)) {
    status = "invite";
  } else if (/\bauto[\s-]*declined\b/i.test(current)) {
    status = "auto-declined";
  } else if (/\bdeclined\b/i.test(current)) {
    status = "declined";
  } else if (/\bunavailable\b/i.test(current)) {
    status = "unavailable";
  } else if (/\breject(?:ed)?\b/i.test(current)) {
    status = "reject";
  } else if (!current && /\bauto[\s-]*declined\b/i.test(history)) {
    status = "auto-declined";
  } else if (!current && /\bdeclined\b/i.test(history)) {
    status = "declined";
  } else if (!current && /\bunavailable\b/i.test(history)) {
    status = "unavailable";
  } else if (!current && /\breject(?:ed)?\b/i.test(history)) {
    status = "reject";
  } else if (/\bagreed\b/i.test(text)) {
    status = "agreed";
  } else if (!current && /\bselected\s*:/i.test(history)) {
    status = "selected";
  } else if (!current && /\binvited\s*:/i.test(history)) {
    status = "invited";
  } else if (overdue) {
    status = "overdue";
  }

  return { status, overdue, text };
}

export function reviewerCountsTowardTarget(reviewer) {
  const { status, overdue } = classifyReviewerStatus(reviewer);
  if (status === "invite" || status === "selected") {
    return true;
  }
  return status === "agreed" && !overdue;
}

export function countReviewersTowardTarget(reviewers) {
  return reviewers.filter(reviewerCountsTowardTarget).length;
}

export function selectUniqueCandidates(candidates, priorReviewers, limit) {
  const selected = [];
  const maximum = Math.max(0, Number.parseInt(limit, 10) || 0);

  for (const candidate of candidates) {
    if (selected.length >= maximum) {
      break;
    }
    if (priorReviewers.some((reviewer) => samePerson(candidate, reviewer))) {
      continue;
    }
    if (selected.some((reviewer) => samePerson(candidate, reviewer))) {
      continue;
    }
    selected.push(candidate);
  }

  return selected;
}
