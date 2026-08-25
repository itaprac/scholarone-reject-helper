import { field, modeDefinition } from "./config/options.js";

// Budowanie argumentów CLI dla zadania uruchamianego z panelu. Kolejność bierze
// się wprost z definicji trybu w config/options.js — nie ma tu drugiej listy,
// która mogłaby się z nią rozjechać.
export function buildJobArgs(mode, body, { report = "" } = {}) {
  const definition = modeDefinition(mode);

  const args = [...definition.flags];
  if (definition.requiresReport) {
    if (!report) {
      throw new Error("Tryb send-from-report wymaga raportu.");
    }
    args.push("--require-targets", `--reject-from-report=${report}`);
  }

  args.push(...valueArgs(definition.fields, body));
  args.push(...flagArgs(definition.trailing, body));
  return args;
}

export function buildReviewerJobArgs(mode, body) {
  if (!["reviewers-prepare", "reviewers-invite"].includes(mode)) {
    throw new Error(`Nieznany tryb reviewerów: ${mode}`);
  }

  const definition = modeDefinition(mode);
  const args = [...definition.flags, `--reviewer-queue=${body.reviewerQueue}`];

  // --invite-all jest jedynym potwierdzeniem realnej wysyłki zaproszeń.
  if (definition.live) {
    args.push("--invite-all");
  }
  if (body.reviewerExcludeManuscriptIds) {
    args.push(`--exclude-manuscript-ids=${body.reviewerExcludeManuscriptIds}`);
  }

  args.push(...valueArgs(definition.fields, body));
  args.push(...flagArgs(definition.trailing, body));
  return args;
}

export function buildScreeningJobArgs(body, { applyDecisions = false } = {}) {
  const definition = modeDefinition("screening");
  const args = [...definition.flags];

  if (applyDecisions) {
    args.push("--apply-assessment-decisions");
  }
  if (body.screeningScanAll) {
    args.push("--scan-all-metadata");
  }

  args.push(...valueArgs(definition.fields, body));
  // Wiadomość odrzucenia i approve bez dobrania edytorów mają sens wyłącznie w
  // przebiegu, który realnie wykonuje decyzje.
  if (applyDecisions) {
    args.push(...valueArgs(["screeningRejectMessage"], body));
    args.push(...flagArgs(["screeningApproveWithoutAssign"], body));
  }
  args.push(...flagArgs(definition.trailing, body));
  return args;
}

export function buildEicAssessmentJobArgs(body, { applyDecisions = false } = {}) {
  const definition = modeDefinition("eic-assessment");
  const args = [...definition.flags];

  if (applyDecisions) args.push("--apply-assessment-decisions");
  if (body.eicAssessmentScanAll) args.push("--scan-all-metadata");

  args.push(...valueArgs(definition.fields, body));
  if (applyDecisions) {
    args.push(...valueArgs(["eicAssessmentRejectMessage"], body));
  }
  args.push(...flagArgs(definition.trailing, body));
  return args;
}

export function buildAssessmentFromRunArgs(body, { run, stage = "initial" } = {}) {
  if (!run) throw new Error("Wykonanie decyzji wymaga zapisanego przebiegu.");
  const eic = stage === "eic";
  const args = ["--headed"];
  if (eic) args.push("--assessment-stage=eic");
  args.push(`--from-run=${run}`);
  args.push(...valueArgs([
    eic ? "eicAssessmentStartUrl" : "screeningStartUrl",
    eic ? "eicAssessmentSlowMo" : "screeningSlowMo",
    eic ? "eicAssessmentRejectMessage" : "screeningRejectMessage",
  ], body));
  args.push(...flagArgs([
    eic ? "eicAssessmentKeepOpen" : "screeningKeepOpen",
  ], body));
  if (!eic) args.push(...flagArgs(["screeningApproveWithoutAssign"], body));
  return args;
}

function valueArgs(keys, body) {
  const args = [];
  for (const key of keys || []) {
    const value = body[key];
    if (value === undefined || value === null || value === "") continue;
    args.push(`--${field(key).flag}=${value}`);
  }
  return args;
}

function flagArgs(keys, body) {
  return (keys || [])
    .filter((key) => Boolean(body[key]))
    .map((key) => `--${field(key).flag}`);
}
