import { parseDateLoose } from "./manuscript-rules.js";

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
  } else if (/\baccount\s+removed\b/i.test(current)) {
    status = "account-removed";
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

function parseReviewerInvitationDate(value) {
  const textual = String(value || "").match(/^(\d{1,2})[-/]([A-Za-z]{3,9})[-/](\d{2,4})$/);
  if (textual) {
    const months = {
      jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
      apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
      aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
      nov: 10, november: 10, dec: 11, december: 11,
    };
    const month = months[textual[2].toLowerCase()];
    if (month !== undefined) {
      const yearValue = Number(textual[3]);
      const year = yearValue < 100 ? yearValue + 2000 : yearValue;
      return new Date(Date.UTC(year, month, Number(textual[1])));
    }
  }
  const parsed = parseDateLoose(String(value || ""));
  if (!parsed) return null;
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
}

export function reviewerInvitationAgeDays(reviewer, { now = new Date() } = {}) {
  const history = String(reviewer?.history || "");
  const matches = [...history.matchAll(
    /\bInvited\s*:\s*(\d{1,2}[-/][A-Za-z]{3,9}[-/]\d{2,4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/gi
  )];
  const dates = matches
    .map((match) => parseReviewerInvitationDate(match[1]))
    .filter(Boolean)
    .filter((date) => date.getTime() <= now.getTime())
    .sort((left, right) => right.getTime() - left.getTime());
  if (!dates.length) return null;
  const older = Date.UTC(dates[0].getUTCFullYear(), dates[0].getUTCMonth(), dates[0].getUTCDate());
  const newer = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((newer - older) / 86_400_000);
}

export function reviewerCountsTowardTarget(reviewer, options = {}) {
  const { status, overdue } = classifyReviewerStatus(reviewer);
  const noResponseDays = options.noResponseDays ?? 60;
  if (status === "invited") {
    const age = reviewerInvitationAgeDays(reviewer, options);
    return age === null || age < noResponseDays;
  }
  if (["invite", "selected"].includes(status)) {
    return !overdue;
  }
  return status === "agreed" && !overdue;
}

export function countReviewersTowardTarget(reviewers, options = {}) {
  return reviewers.filter((reviewer) => reviewerCountsTowardTarget(reviewer, options)).length;
}

export function reviewerNeedsReplacement(reviewer, options = {}) {
  const { status, overdue } = classifyReviewerStatus(reviewer);
  if (["selected", "invite"].includes(status)) {
    return false;
  }
  if (status === "invited") {
    const age = reviewerInvitationAgeDays(reviewer, options);
    return age !== null && age >= (options.noResponseDays ?? 60);
  }
  return overdue || [
    "declined",
    "auto-declined",
    "unavailable",
    "reject",
    "account-removed",
  ].includes(status);
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
