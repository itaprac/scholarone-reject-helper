const state = {
  reports: [],
  screeningRuns: [],
  screeningRun: null,
  selectedReportPath: "",
  currentJob: null,
  stream: null,
  pollTimer: null,
  configApplied: false,
  activeView: "reject",
};

const REPORT_COLUMN_COUNT = 5;
const REPORT_STATUS_LABELS = {
  dry_run_finished: "Dry run finished",
  report_only_finished: "Report finished",
  search_dry_run_finished: "Search dry run finished",
  search_report_finished: "Search report finished",
  search_reject_finished: "Reject finished",
  no_more_view_details: "Queue completed",
  max_checked_reached: "Check limit reached",
  max_rejected_reached: "Reject limit reached",
  reject_step_failed: "Reject step failed",
  save_send_failed: "Send failed",
  needs_manual_review: "Manual review needed",
};

const els = {
  rejectTab: document.getElementById("rejectTab"),
  screeningTab: document.getElementById("screeningTab"),
  reviewersTab: document.getElementById("reviewersTab"),
  rejectPanel: document.getElementById("rejectPanel"),
  screeningPanel: document.getElementById("screeningPanel"),
  reviewersPanel: document.getElementById("reviewersPanel"),
  statusLine: document.getElementById("statusLine"),
  refreshBtn: document.getElementById("refreshBtn"),
  startUrl: document.getElementById("startUrl"),
  maxChecked: document.getElementById("maxChecked"),
  olderDays: document.getElementById("olderDays"),
  queuePage: document.getElementById("queuePage"),
  slowMo: document.getElementById("slowMo"),
  maxRejected: document.getElementById("maxRejected"),
  keepOpen: document.getElementById("keepOpen"),
  settingsStatus: document.getElementById("settingsStatus"),
  rejectMessage: document.getElementById("rejectMessage"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  resetSettingsBtn: document.getElementById("resetSettingsBtn"),
  dryRunBtn: document.getElementById("dryRunBtn"),
  liveRunBtn: document.getElementById("liveRunBtn"),
  reportsBody: document.getElementById("reportsBody"),
  selectedReport: document.getElementById("selectedReport"),
  sendReportBtn: document.getElementById("sendReportBtn"),
  stopBtn: document.getElementById("stopBtn"),
  jobOutput: document.getElementById("jobOutput"),
  jobProgress: document.getElementById("jobProgress"),
  doctorLine: document.getElementById("doctorLine"),
  reviewerQueue: document.getElementById("reviewerQueue"),
  reviewerMaxManuscripts: document.getElementById("reviewerMaxManuscripts"),
  reviewersPerPaper: document.getElementById("reviewersPerPaper"),
  reviewerStartUrl: document.getElementById("reviewerStartUrl"),
  reviewerSlowMo: document.getElementById("reviewerSlowMo"),
  reviewerRefreshWaitSeconds: document.getElementById("reviewerRefreshWaitSeconds"),
  reviewerKeepOpen: document.getElementById("reviewerKeepOpen"),
  reviewerBatchSummary: document.getElementById("reviewerBatchSummary"),
  prepareReviewersBtn: document.getElementById("prepareReviewersBtn"),
  inviteReviewersBtn: document.getElementById("inviteReviewersBtn"),
  saveReviewerSettingsBtn: document.getElementById("saveReviewerSettingsBtn"),
  reviewerSettingsStatus: document.getElementById("reviewerSettingsStatus"),
  screeningStartUrl: document.getElementById("screeningStartUrl"),
  screeningScope: document.getElementById("screeningScope"),
  screeningMaxChecked: document.getElementById("screeningMaxChecked"),
  screeningSlowMo: document.getElementById("screeningSlowMo"),
  assessmentModel: document.getElementById("assessmentModel"),
  assessmentReasoningEffort: document.getElementById("assessmentReasoningEffort"),
  assessmentTimeoutSeconds: document.getElementById("assessmentTimeoutSeconds"),
  assessmentPrompt: document.getElementById("assessmentPrompt"),
  screeningRejectMessage: document.getElementById("screeningRejectMessage"),
  screeningDryRunBtn: document.getElementById("screeningDryRunBtn"),
  screeningLiveRunBtn: document.getElementById("screeningLiveRunBtn"),
  saveScreeningSettingsBtn: document.getElementById("saveScreeningSettingsBtn"),
  screeningSettingsStatus: document.getElementById("screeningSettingsStatus"),
  screeningRunSelect: document.getElementById("screeningRunSelect"),
  screeningDecisionFilter: document.getElementById("screeningDecisionFilter"),
  screeningRunSummary: document.getElementById("screeningRunSummary"),
  screeningResultsBody: document.getElementById("screeningResultsBody"),
  refreshScreeningRunsBtn: document.getElementById("refreshScreeningRunsBtn"),
};

els.rejectTab.addEventListener("click", () => activateView("reject"));
els.screeningTab.addEventListener("click", () => activateView("screening"));
els.reviewersTab.addEventListener("click", () => activateView("reviewers"));
const workflowTabs = [
  { view: "reject", tab: els.rejectTab },
  { view: "screening", tab: els.screeningTab },
  { view: "reviewers", tab: els.reviewersTab },
];
for (const { view, tab } of workflowTabs) {
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const index = workflowTabs.findIndex((item) => item.view === view);
    const next = workflowTabs[(index + direction + workflowTabs.length) % workflowTabs.length];
    activateView(next.view);
    next.tab.focus();
  });
}
els.reviewerMaxManuscripts.addEventListener("input", renderReviewerBatchSummary);
els.reviewersPerPaper.addEventListener("input", renderReviewerBatchSummary);
els.reviewerQueue.addEventListener("change", renderReviewerBatchSummary);
els.screeningScope.addEventListener("change", renderScreeningScope);
bindAsyncClick(els.refreshBtn, refresh);
bindAsyncClick(els.dryRunBtn, runDryRun);
bindAsyncClick(els.liveRunBtn, runLiveSend);
bindAsyncClick(els.sendReportBtn, sendSelectedReport);
bindAsyncClick(els.saveSettingsBtn, saveSettings);
bindAsyncClick(els.resetSettingsBtn, resetSettings);
bindAsyncClick(els.stopBtn, stopCurrentJob);
bindAsyncClick(els.prepareReviewersBtn, runReviewerPreparation);
bindAsyncClick(els.inviteReviewersBtn, runReviewerBatch);
bindAsyncClick(els.saveReviewerSettingsBtn, saveReviewerSettings);
bindAsyncClick(els.screeningDryRunBtn, runMetadataCollection);
bindAsyncClick(els.screeningLiveRunBtn, runLiveAssessment);
bindAsyncClick(els.saveScreeningSettingsBtn, saveScreeningSettings);

els.screeningRunSelect?.addEventListener("change", () => loadScreeningRun().catch(showError));
els.screeningDecisionFilter?.addEventListener("change", renderScreeningResults);
if (els.refreshScreeningRunsBtn) bindAsyncClick(els.refreshScreeningRunsBtn, refreshScreeningRuns);

refresh().catch(showError);
refreshDoctor().catch(() => undefined);
refreshScreeningRuns().catch(() => undefined);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function refresh() {
  const payload = await api("/api/state");
  if (!state.configApplied && payload.config) {
    applyConfig(payload.config);
    state.configApplied = true;
  }
  state.reports = payload.reports || [];
  if (payload.activeJob) {
    setJob(payload.activeJob);
  }
  renderReports();
  renderJob();
  updateActionState();
}

async function refreshScreeningRuns() {
  if (!els.screeningRunSelect) return;

  const { runs } = await api("/api/screening/runs");
  state.screeningRuns = runs;
  els.screeningRunSelect.replaceChildren();

  if (runs.length === 0) {
    els.screeningRunSummary.textContent = "Brak zapisanych przebiegów";
    els.screeningResultsBody.replaceChildren();
    return;
  }

  for (const run of runs) {
    const option = document.createElement("option");
    option.value = run.filename;
    const when = run.createdAt ? formatReportDate(run.createdAt) : run.runId;
    option.textContent = `${when} · ${run.manuscriptCount} art. ${run.live ? "· live" : ""}`.trim();
    els.screeningRunSelect.append(option);
  }

  await loadScreeningRun();
}

async function loadScreeningRun() {
  const filename = els.screeningRunSelect?.value;
  if (!filename) return;

  const { run } = await api(`/api/screening/runs/${encodeURIComponent(filename)}`);
  state.screeningRun = run;
  renderScreeningResults();
}

function renderScreeningResults() {
  const run = state.screeningRun;
  if (!run || !els.screeningResultsBody) return;

  const filter = els.screeningDecisionFilter?.value || "";
  const rows = run.manuscripts.filter((row) => {
    if (!filter) return true;
    if (filter === "ERROR") return Boolean(row.assessmentError || row.actionError);
    return row.decision === filter;
  });

  const summary = run.summary || {};
  els.screeningRunSummary.textContent = [
    `${run.manuscripts.length} artykułów`,
    summary.approved !== undefined ? `APPROVE ${summary.approved}` : null,
    summary.rejected !== undefined ? `REJECT ${summary.rejected}` : null,
    summary.assessmentErrors ? `błędy ${summary.assessmentErrors}` : null,
    run.live ? "tryb live" : "dry run",
  ].filter(Boolean).join(" · ");

  els.screeningResultsBody.replaceChildren();

  if (rows.length === 0) {
    const empty = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "Brak wyników dla wybranego filtra.";
    empty.append(cell);
    els.screeningResultsBody.append(empty);
    return;
  }

  for (const row of rows) {
    els.screeningResultsBody.append(screeningRow(row));
  }
}

function screeningRow(row) {
  const tr = document.createElement("tr");

  const idCell = document.createElement("td");
  const id = document.createElement("strong");
  id.textContent = row.manuscriptId || "—";
  const title = document.createElement("span");
  title.className = "row-subtitle";
  title.textContent = row.title;
  // Abstrakt bywa długi; pokazujemy go dopiero na żądanie.
  const details = document.createElement("details");
  const label = document.createElement("summary");
  label.textContent = "abstrakt";
  const abstract = document.createElement("p");
  abstract.className = "row-abstract";
  abstract.textContent = row.abstract || "(brak)";
  details.append(label, abstract);
  idCell.append(id, title, details);

  const decisionCell = document.createElement("td");
  decisionCell.textContent = row.decision || (row.assessmentError ? "BŁĄD" : "—");
  decisionCell.dataset.decision = row.decision || (row.assessmentError ? "ERROR" : "");
  if (row.cached) decisionCell.title = "wynik z cache";

  const reasonCell = document.createElement("td");
  reasonCell.textContent = row.assessmentError || row.reason || "—";

  const tokensCell = document.createElement("td");
  tokensCell.className = "numeric";
  tokensCell.textContent = row.cached ? "cache" : (row.totalTokens ?? "—");

  const actionCell = document.createElement("td");
  actionCell.textContent = row.actionError
    ? `błąd: ${row.actionError}`
    : row.actionCompleted
      ? `wykonano ${row.actionDecision}`
      : "—";

  tr.append(idCell, decisionCell, reasonCell, tokensCell, actionCell);
  return tr;
}

// Preflight przy starcie panelu. Pokazujemy tylko to, co wymaga uwagi — przy
// sprawnym środowisku linijka zostaje ukryta i nie zabiera miejsca.
async function refreshDoctor() {
  if (!els.doctorLine) return;

  try {
    const { checks } = await api("/api/doctor");
    const problems = checks.filter((check) => check.status !== "ok");

    if (problems.length === 0) {
      els.doctorLine.hidden = true;
      return;
    }

    els.doctorLine.hidden = false;
    els.doctorLine.textContent = problems
      .map((check) => `${check.name}: ${check.detail}${check.hint ? ` — ${check.hint}` : ""}`)
      .join(" · ");
  } catch {
    els.doctorLine.hidden = true;
  }
}

async function runDryRun() {
  if (!validateInputs([els.startUrl, els.maxChecked, els.olderDays, els.queuePage, els.slowMo])) {
    return;
  }

  const payload = await api("/api/run/dryrun", {
    method: "POST",
    body: JSON.stringify(scanOptions({ includeMaxRejected: false })),
  });
  setJob(payload.job);
}

async function runLiveSend() {
  if (!validateInputs([
    els.startUrl,
    els.maxChecked,
    els.olderDays,
    els.queuePage,
    els.slowMo,
    els.maxRejected,
  ])) {
    return;
  }

  if (!confirmDangerousAction("Uruchomic skanowanie i od razu odrzucac pasujace artykuly?")) {
    return;
  }

  const payload = await api("/api/run/live", {
    method: "POST",
    body: JSON.stringify(scanOptions({ includeMaxRejected: true })),
  });
  setJob(payload.job);
}

async function sendSelectedReport() {
  if (!state.selectedReportPath) {
    showError(new Error("Wybierz raport z tabeli."));
    return;
  }
  if (!validateInputs([els.startUrl, els.olderDays, els.slowMo, els.maxRejected])) {
    return;
  }
  if (!confirmDangerousAction(`Odrzucic kandydatow z raportu?\n\n${state.selectedReportPath}`)) {
    return;
  }

  const payload = await api("/api/run/send-from-report", {
    method: "POST",
    body: JSON.stringify({
      report: state.selectedReportPath,
      ...sendOptions(),
    }),
  });
  setJob(payload.job);
}

async function runReviewerPreparation() {
  if (!validateInputs(reviewerInputs())) return;

  const payload = await api("/api/run/reviewers/prepare", {
    method: "POST",
    body: JSON.stringify({
      ...reviewerOptions(),
      reviewerMaxManuscripts: "1",
      reviewerKeepOpen: true,
    }),
  });
  setJob(payload.job);
}

async function runReviewerBatch() {
  if (!validateInputs(reviewerInputs())) return;

  const payload = await api("/api/run/reviewers/invite", {
    method: "POST",
    body: JSON.stringify(reviewerOptions()),
  });
  setJob(payload.job);
}

async function runMetadataCollection() {
  if (!validateInputs(screeningInputs())) return;

  const payload = await api("/api/run/screening/collect", {
    method: "POST",
    body: JSON.stringify(screeningOptions()),
  });
  setJob(payload.job);
}

async function runLiveAssessment() {
  if (!validateInputs(screeningInputs())) return;

  const scope = els.screeningScope.value === "all"
    ? "całą kolejkę Complete Checklist"
    : `maksymalnie ${valueOf(els.screeningMaxChecked)} manuskryptów`;
  if (!confirmDangerousAction(
    `Uruchomić LIVE dla ${scope}?\n\nAPPROVE i REJECT zostaną naprawdę wykonane w ScholarOne. Wiadomości Reject zostaną wysłane, a zatwierdzone prace zostaną przypisane do Wojciecha Sałabuna jako EIC i AE.`
  )) {
    return;
  }

  const payload = await api("/api/run/screening/live", {
    method: "POST",
    body: JSON.stringify({
      ...screeningOptions(),
      screeningLive: true,
    }),
  });
  setJob(payload.job);
}

async function saveSettings() {
  const payload = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify(settingsOptions()),
  });
  applyConfig(payload.config);
  els.settingsStatus.textContent = `Saved to ${payload.config.settingsPath}`;
}

async function resetSettings() {
  if (!window.confirm("Usunac zapisane ustawienia UI i wrocic do .env/domyslnych?")) {
    return;
  }

  const payload = await api("/api/settings/reset", { method: "POST" });
  applyConfig(payload.config);
  els.settingsStatus.textContent = "Reset to defaults";
}

async function saveReviewerSettings() {
  const payload = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify(settingsOptions()),
  });
  applyConfig(payload.config);
  els.reviewerSettingsStatus.textContent = `Saved to ${payload.config.settingsPath}`;
}

async function saveScreeningSettings() {
  const payload = await api("/api/settings", {
    method: "POST",
    body: JSON.stringify(settingsOptions()),
  });
  applyConfig(payload.config);
  els.screeningSettingsStatus.textContent = `Saved to ${payload.config.settingsPath}`;
}

async function stopCurrentJob() {
  if (!state.currentJob?.id) {
    return;
  }
  const payload = await api(`/api/jobs/${state.currentJob.id}/stop`, { method: "POST" });
  setJob(payload.job);
}

function setJob(job) {
  state.currentJob = job || null;
  renderJob();
  updateActionState();

  closeStream();
  if (job && ["running", "stopping"].includes(job.status)) {
    openStream(job.id);
  }
}

function closeStream() {
  state.stream?.close();
  state.stream = null;
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// Serwer wypycha przyrost, zamiast oddawać cały bufor przy każdym odpytaniu.
// Polling zostaje wyłącznie jako zapasowa ścieżka, gdyby strumień padł.
function openStream(jobId) {
  const stream = new EventSource(`/api/jobs/${jobId}/stream`);
  state.stream = stream;

  stream.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === "snapshot" && payload.job) {
      state.currentJob = payload.job;
      renderJob();
      updateActionState();
      return;
    }

    if (payload.type === "output" && state.currentJob) {
      // Doklejamy ogon zamiast przerysowywać całość — scroll przestaje skakać.
      state.currentJob.output = (state.currentJob.output || "") + payload.chunk;
      state.currentJob.offset = payload.offset;
      state.currentJob.progress = payload.progress;
      appendJobOutput(payload.chunk);
      renderProgress(payload.progress);
      return;
    }

    if (payload.type === "status" && payload.job) {
      state.currentJob = payload.job;
      renderJob();
      updateActionState();
      closeStream();
      refresh().catch(showError);
    }
  });

  stream.addEventListener("error", () => {
    closeStream();
    if (!state.pollTimer) {
      state.pollTimer = setInterval(pollJob, 2000);
    }
  });
}

async function pollJob() {
  if (!state.currentJob?.id) {
    return;
  }

  try {
    const since = state.currentJob.offset || 0;
    const payload = await api(`/api/jobs/${state.currentJob.id}?since=${since}`);
    if (payload.job) {
      const merged = {
        ...payload.job,
        output: (state.currentJob.output || "") + (payload.job.output || ""),
      };
      state.currentJob = merged;
      renderJob();
      updateActionState();
    }
    if (!payload.job || !["running", "stopping"].includes(payload.job.status)) {
      closeStream();
      await refresh();
    }
  } catch (error) {
    showError(error);
  }
}

function appendJobOutput(chunk) {
  const atBottom =
    els.jobOutput.scrollHeight - els.jobOutput.scrollTop - els.jobOutput.clientHeight < 40;
  els.jobOutput.textContent += chunk;
  // Przewijamy tylko wtedy, gdy użytkownik i tak jest na dole — inaczej
  // czytanie starszych linii byłoby niemożliwe przy aktywnym przebiegu.
  if (atBottom) {
    els.jobOutput.scrollTop = els.jobOutput.scrollHeight;
  }
}

function renderProgress(progress) {
  if (!els.jobProgress || !progress) return;

  const parts = [];
  if (progress.checked) parts.push(`sprawdzone: ${progress.checked}`);
  if (progress.currentManuscriptId) parts.push(progress.currentManuscriptId);

  const approve = progress.decisions?.APPROVE || 0;
  const reject = progress.decisions?.REJECT || 0;
  if (approve || reject) parts.push(`APPROVE ${approve} / REJECT ${reject}`);
  if (progress.sent) parts.push(`wysłane: ${progress.sent}`);
  if (progress.liveActions) {
    parts.push(`akcje live: ${progress.liveActions}${progress.liveActionLimit ? `/${progress.liveActionLimit}` : ""}`);
  }
  if (progress.cacheHits) parts.push(`cache: ${progress.cacheHits}`);
  if (progress.skipped) parts.push(`pominięte: ${progress.skipped}`);
  if (progress.errors) parts.push(`błędy: ${progress.errors}`);
  if (progress.tokenSummary) parts.push(progress.tokenSummary);

  els.jobProgress.textContent = parts.join(" · ") || "—";
  els.jobProgress.hidden = parts.length === 0;
}

function renderReports() {
  els.reportsBody.replaceChildren();

  if (state.reports.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = REPORT_COLUMN_COUNT;
    cell.textContent = "Brak raportow. Uruchom dry run.";
    row.append(cell);
    els.reportsBody.append(row);
    state.selectedReportPath = "";
    renderSelectedReport();
    return;
  }

  const selectedStillExists = state.reports.some((report) => report.path === state.selectedReportPath);
  if (state.selectedReportPath && !selectedStillExists) {
    state.selectedReportPath = "";
  }

  for (const report of state.reports) {
    const row = document.createElement("tr");
    row.className = "report-row";
    row.tabIndex = 0;
    row.setAttribute("aria-selected", String(report.path === state.selectedReportPath));
    if (report.path === state.selectedReportPath) {
      row.classList.add("selected");
    }
    row.addEventListener("click", () => selectReport(report.path));
    row.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) {
        return;
      }
      event.preventDefault();
      selectReport(report.path, { restoreFocus: true });
    });

    row.append(
      reportNameCell(report),
      textCell(reportStatusLabel(report.status)),
      textCell(String(report.checked)),
      countCell(report.candidates),
      textCell(progressText(report)),
    );
    els.reportsBody.append(row);
  }

  renderSelectedReport();
}

function reportNameCell(report) {
  const cell = document.createElement("td");
  const name = document.createElement("div");
  name.className = "report-name";
  name.textContent = formatReportDate(report.createdAt);
  const path = document.createElement("div");
  path.className = "path";
  path.textContent = report.filename;
  path.title = report.path;
  cell.append(name, path);
  return cell;
}

function textCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

function countCell(value) {
  const cell = document.createElement("td");
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = String(value || 0);
  cell.append(pill);
  return cell;
}

function progressText(report) {
  const parts = [];
  if (report.progressRejected) parts.push(`sent ${report.progressRejected}`);
  if (report.progressSkipped) parts.push(`skipped ${report.progressSkipped}`);
  return parts.length ? parts.join(", ") : "Not started";
}

function selectReport(reportPath, { restoreFocus = false } = {}) {
  state.selectedReportPath = reportPath;
  renderReports();
  updateActionState();

  if (restoreFocus) {
    const selectedRow = Array.from(els.reportsBody.querySelectorAll("tr.report-row"))
      .find((row) => row.getAttribute("aria-selected") === "true");
    selectedRow?.focus();
  }
}

function reportStatusLabel(status) {
  if (!status) {
    return "Unknown";
  }
  return REPORT_STATUS_LABELS[status] || status.replaceAll("_", " ");
}

function formatReportDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Report";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function renderSelectedReport() {
  const report = state.reports.find((item) => item.path === state.selectedReportPath);
  if (!report) {
    els.selectedReport.textContent = "No report selected";
    return;
  }
  els.selectedReport.textContent = `${report.candidates || 0} candidates, ${report.progressRejected || 0} sent`;
}

function renderJob() {
  const job = state.currentJob;
  if (!job) {
    els.statusLine.textContent = "Ready";
    els.statusLine.dataset.tone = "neutral";
    els.jobOutput.textContent = "No active job.";
    if (els.jobProgress) els.jobProgress.hidden = true;
    els.stopBtn.disabled = true;
    return;
  }

  const status = `${job.type} ${job.status}`;
  els.statusLine.textContent = job.exitCode === null ? status : `${status}, exit ${job.exitCode}`;
  els.statusLine.dataset.tone = job.status === "failed" ? "error" : "active";
  els.jobOutput.textContent = job.output || "Job started...";
  els.jobOutput.scrollTop = els.jobOutput.scrollHeight;
  renderProgress(job.progress);
  els.stopBtn.disabled = !["running", "stopping"].includes(job.status);
}

function updateActionState() {
  const jobRunning = state.currentJob && ["running", "stopping"].includes(state.currentJob.status);
  els.dryRunBtn.disabled = jobRunning;
  els.liveRunBtn.disabled = jobRunning;
  els.sendReportBtn.disabled = jobRunning || !state.selectedReportPath;
  els.prepareReviewersBtn.disabled = jobRunning;
  els.inviteReviewersBtn.disabled = jobRunning;
  els.screeningDryRunBtn.disabled = jobRunning;
  els.screeningLiveRunBtn.disabled = jobRunning;
}

function activateView(view) {
  state.activeView = view;
  const views = [
    { name: "reject", tab: els.rejectTab, panel: els.rejectPanel },
    { name: "screening", tab: els.screeningTab, panel: els.screeningPanel },
    { name: "reviewers", tab: els.reviewersTab, panel: els.reviewersPanel },
  ];
  for (const item of views) {
    const active = item.name === view;
    item.panel.hidden = !active;
    item.tab.classList.toggle("selected", active);
    item.tab.setAttribute("aria-selected", String(active));
    item.tab.tabIndex = active ? 0 : -1;
  }
}

function showError(error) {
  els.statusLine.textContent = error.message;
  els.statusLine.dataset.tone = "error";
  console.error(error);
}

function bindAsyncClick(element, handler) {
  element.addEventListener("click", () => {
    handler().catch(showError);
  });
}

function validateInputs(inputs) {
  const invalidInput = inputs.find((input) => !input.checkValidity());
  if (!invalidInput) {
    return true;
  }

  const details = invalidInput.closest("details");
  if (details) {
    details.open = true;
  }
  invalidInput.focus();
  invalidInput.reportValidity();
  return false;
}

function valueOf(input) {
  return input.value.trim();
}

function applyConfig(config) {
  setValue(els.startUrl, config.startUrl);
  setValue(els.maxChecked, config.maxChecked);
  setValue(els.olderDays, config.submittedOlderThanDays);
  setValue(els.queuePage, config.queueStartPage);
  setValue(els.slowMo, config.slowMo);
  setValue(els.maxRejected, config.maxRejected);
  setValue(els.rejectMessage, config.rejectMessage);
  els.keepOpen.checked = Boolean(config.keepOpen);
  setValue(els.reviewerStartUrl, config.reviewerStartUrl);
  setValue(els.reviewerQueue, config.reviewerQueue);
  setValue(els.reviewersPerPaper, config.reviewersPerPaper);
  setValue(els.reviewerMaxManuscripts, config.reviewerMaxManuscripts);
  setValue(els.reviewerSlowMo, config.reviewerSlowMo);
  setValue(els.reviewerRefreshWaitSeconds, config.reviewerRefreshWaitSeconds);
  els.reviewerKeepOpen.checked = Boolean(config.reviewerKeepOpen);
  setValue(els.screeningStartUrl, config.screeningStartUrl);
  setValue(els.screeningScope, config.screeningScanAll ? "all" : "limited");
  setValue(els.screeningMaxChecked, config.screeningMaxChecked);
  setValue(els.screeningSlowMo, config.screeningSlowMo);
  setValue(els.assessmentModel, config.assessmentModel);
  setValue(els.assessmentReasoningEffort, config.assessmentReasoningEffort);
  setValue(els.assessmentTimeoutSeconds, config.assessmentTimeoutSeconds);
  setValue(els.assessmentPrompt, config.assessmentPrompt);
  setValue(els.screeningRejectMessage, config.screeningRejectMessage);
  renderScreeningScope();
  renderReviewerBatchSummary();
  const settingsStatus = config.settingsSaved
    ? `Saved: ${config.settingsPath}`
    : "Loaded from .env/defaults";
  els.settingsStatus.textContent = settingsStatus;
  els.reviewerSettingsStatus.textContent = settingsStatus;
  els.screeningSettingsStatus.textContent = settingsStatus;
}

function setValue(input, value) {
  if (value !== undefined && value !== null) {
    input.value = value;
  }
}

function scanOptions({ includeMaxRejected }) {
  const options = formOptions();
  if (!includeMaxRejected) {
    delete options.maxRejected;
  }
  return options;
}

function sendOptions() {
  const { maxChecked, queueStartPage, ...options } = formOptions();
  return options;
}

function settingsOptions() {
  return {
    ...formOptions(),
    ...reviewerOptions(),
    ...screeningOptions(),
  };
}

function screeningInputs() {
  const inputs = [
    els.screeningStartUrl,
    els.screeningSlowMo,
    els.assessmentModel,
    els.assessmentReasoningEffort,
    els.assessmentTimeoutSeconds,
    els.assessmentPrompt,
    els.screeningRejectMessage,
  ];
  if (els.screeningScope.value === "limited") {
    inputs.push(els.screeningMaxChecked);
  }
  return inputs;
}

function screeningOptions() {
  return {
    screeningStartUrl: valueOf(els.screeningStartUrl),
    screeningMaxChecked: valueOf(els.screeningMaxChecked),
    screeningScanAll: els.screeningScope.value === "all",
    screeningSlowMo: valueOf(els.screeningSlowMo),
    screeningKeepOpen: false,
    assessmentModel: valueOf(els.assessmentModel),
    assessmentReasoningEffort: els.assessmentReasoningEffort.value,
    assessmentTimeoutSeconds: valueOf(els.assessmentTimeoutSeconds),
    assessmentPrompt: valueOf(els.assessmentPrompt),
    screeningRejectMessage: valueOf(els.screeningRejectMessage),
  };
}

function renderScreeningScope() {
  const scanAll = els.screeningScope.value === "all";
  els.screeningMaxChecked.disabled = scanAll;
  els.screeningDryRunBtn.textContent = scanAll
    ? "Dry run entire queue"
    : "Dry run limited batch";
  els.screeningLiveRunBtn.textContent = scanAll
    ? "Live entire queue"
    : "Live limited batch";
  els.screeningMaxChecked.title = scanAll
    ? "Limit jest wyłączony podczas skanowania całej kolejki."
    : "Maksymalna liczba manuskryptów sprawdzonych w tym przebiegu.";
}

function reviewerInputs() {
  return [
    els.reviewerStartUrl,
    els.reviewerMaxManuscripts,
    els.reviewersPerPaper,
    els.reviewerSlowMo,
    els.reviewerRefreshWaitSeconds,
  ];
}

function reviewerOptions() {
  return {
    reviewerStartUrl: valueOf(els.reviewerStartUrl),
    reviewerQueue: els.reviewerQueue.value,
    reviewerMaxManuscripts: valueOf(els.reviewerMaxManuscripts),
    reviewersPerPaper: valueOf(els.reviewersPerPaper),
    reviewerSlowMo: valueOf(els.reviewerSlowMo),
    reviewerRefreshWaitSeconds: valueOf(els.reviewerRefreshWaitSeconds),
    reviewerKeepOpen: els.reviewerKeepOpen.checked,
  };
}

function renderReviewerBatchSummary() {
  const papers = valueOf(els.reviewerMaxManuscripts) || "0";
  const reviewers = valueOf(els.reviewersPerPaper) || "0";
  const queue = {
    combined: "Combined queue",
    invite: "Invite Reviewers",
    select: "Select Reviewers",
  }[els.reviewerQueue.value] || "Combined queue";
  els.reviewerBatchSummary.textContent = `Up to ${papers} papers, ${reviewers} reviewers each, from ${queue}`;
}

function formOptions() {
  return {
    startUrl: valueOf(els.startUrl),
    maxChecked: valueOf(els.maxChecked),
    submittedOlderThanDays: valueOf(els.olderDays),
    queueStartPage: valueOf(els.queuePage),
    slowMo: valueOf(els.slowMo),
    maxRejected: valueOf(els.maxRejected),
    keepOpen: els.keepOpen.checked,
    rejectMessage: valueOf(els.rejectMessage),
  };
}

function confirmDangerousAction(message) {
  return window.confirm(`${message}\n\nTej akcji nie da sie cofnac w ScholarOne.`);
}
