// Parsowanie i zapis CSV dla raportów przebiegu. Bez zależności od Playwrighta —
// wszystko tutaj da się przetestować bez uruchamiania przeglądarki.
import { normalizeManuscriptId } from "../manuscript-rules.js";

export function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }

  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

export function splitCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

export function rowsToCsv(rows) {
  const headers = [
    "runId",
    "source",
    "category",
    "manuscriptId",
    "action",
    "result",
    "reason",
    "submittedDate",
    "hasUnusualActivity",
    "isRevision",
    "submittedMoreThanLimit",
  ];
  const lines = [headers.join(",")];

  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }

  return `${lines.join("\n")}\n`;
}

export function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function boolCsv(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  return value ? "true" : "false";
}

export function extractCandidateIdsFromJson(payload) {
  const candidates =
    payload?.result?.report?.candidates ||
    payload?.report?.candidates ||
    payload?.candidates ||
    [];

  if (Array.isArray(candidates)) {
    return candidates.map((entry) => entry?.manuscriptId).filter(Boolean);
  }

  return [];
}

export function extractCandidateIdsFromCsv(content) {
  const rows = parseCsv(content);
  return rows
    .filter((row) =>
      /candidate/i.test(row.category || "") ||
      /would_reject/i.test(row.result || "")
    )
    .map((row) => row.manuscriptId)
    .filter(Boolean);
}
