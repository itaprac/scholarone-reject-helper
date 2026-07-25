// Budowa podsumowań i wierszy raportu z wyniku przebiegu.
import { boolCsv } from "./csv.js";

export function createReportSummary() {
  return {
    candidates: [],
    skippedRevision: [],
    skippedOther: [],
    manualReview: [],
  };
}

export function recordReportDecision(report, details) {
  const entry = {
    manuscriptId: details.manuscriptId,
    action: details.action,
    reason: details.reason,
    submittedDate: details.submittedDate || null,
    hasUnusualActivity: Boolean(details.hasUnusualActivity),
    isRevision: Boolean(details.isRevision),
    submittedMoreThanLimit: Boolean(details.submittedMoreThanLimit),
  };

  if (details.action === "candidate") {
    report.candidates.push(entry);
    return;
  }

  if (details.action === "skip" && details.isRevision) {
    report.skippedRevision.push(entry);
    return;
  }

  if (details.action === "skip") {
    report.skippedOther.push(entry);
    return;
  }

  report.manualReview.push(entry);
}

export function buildRunSummary(result) {
  const report = result.report || createReportSummary();
  const searchResults = result.results || [];
  return {
    checked: result.checked || 0,
    rejected: result.rejected || 0,
    wouldReject: report.candidates?.length || 0,
    skippedRevision: report.skippedRevision?.length || 0,
    skippedOther: report.skippedOther?.length || 0,
    manualReview: report.manualReview?.length || 0,
    targets: result.targets || null,
    searchSent: searchResults.filter((entry) => entry.status === "sent").length,
    searchWouldReject: searchResults.filter((entry) => entry.status === "would_reject").length,
    searchNotFound: searchResults.filter((entry) => entry.status === "not_found").length,
    searchAlreadyProcessed: searchResults.filter((entry) => entry.status === "already_processed").length,
    searchNotActionable: searchResults.filter((entry) => entry.status === "not_actionable_no_reject_control").length,
  };
}

export function collectArtifactRows(result, runId) {
  const rows = [];
  appendReportRows(rows, result.report, result.results ? "search-check" : "scan", runId);

  for (const entry of result.results || []) {
    const details = entry.details || {};
    rows.push({
      runId,
      source: "search",
      category: entry.status || "",
      manuscriptId: entry.manuscriptId || details.manuscriptId || "",
      action: details.action || "",
      result: entry.status || "",
      reason: details.reason || entry.note || entry.progress?.status || entry.searchResult?.note || "",
      submittedDate: details.submittedDate || "",
      hasUnusualActivity: boolCsv(details.hasUnusualActivity),
      isRevision: boolCsv(details.isRevision),
      submittedMoreThanLimit: boolCsv(details.submittedMoreThanLimit),
    });
  }

  if (rows.length === 0) {
    rows.push({
      runId,
      source: "run",
      category: result.status || "",
      manuscriptId: "",
      action: "",
      result: result.status || "",
      reason: result.note || "",
      submittedDate: "",
      hasUnusualActivity: "",
      isRevision: "",
      submittedMoreThanLimit: "",
    });
  }

  return rows;
}

export function appendReportRows(rows, report, source, runId) {
  if (!report) {
    return;
  }

  const categories = [
    ["candidate", report.candidates || []],
    ["skippedRevision", report.skippedRevision || []],
    ["skippedOther", report.skippedOther || []],
    ["manualReview", report.manualReview || []],
  ];

  for (const [category, entries] of categories) {
    for (const entry of entries) {
      rows.push({
        runId,
        source,
        category,
        manuscriptId: entry.manuscriptId || "",
        action: entry.action || "",
        result: category === "candidate" ? "would_reject" : "skip",
        reason: entry.reason || "",
        submittedDate: entry.submittedDate || "",
        hasUnusualActivity: boolCsv(entry.hasUnusualActivity),
        isRevision: boolCsv(entry.isRevision),
        submittedMoreThanLimit: boolCsv(entry.submittedMoreThanLimit),
      });
    }
  }
}

export function simpleHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
