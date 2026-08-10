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

const MONITOR_POLL_MS = 2500;
const MONITOR_TICK_MS = 1000;
const MONITOR_TAIL = 100;
const MONITOR_QUIET_AFTER_SECONDS = 45;

const monitorState = {
  run: null,
  events: [],
  offline: false,
  offlineMessage: "",
  renderedRunId: null,
  renderedEventCount: -1,
  // "live" śledzi current-run.json; nazwa pliku JSONL pokazuje stary przebieg.
  view: "live",
  archive: null,
  lastLiveStatus: null,
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
  monitorTab: document.getElementById("monitorTab"),
  rejectPanel: document.getElementById("rejectPanel"),
  screeningPanel: document.getElementById("screeningPanel"),
  reviewersPanel: document.getElementById("reviewersPanel"),
  monitorPanel: document.getElementById("monitorPanel"),
  beaconDot: document.getElementById("beaconDot"),
  beaconStatus: document.getElementById("beaconStatus"),
  beaconNote: document.getElementById("beaconNote"),
  factMode: document.getElementById("factMode"),
  factPid: document.getElementById("factPid"),
  factStarted: document.getElementById("factStarted"),
  factHeartbeat: document.getElementById("factHeartbeat"),
  factHeartbeatLabel: document.getElementById("factHeartbeatLabel"),
  monitorRunSelect: document.getElementById("monitorRunSelect"),
  tileChecked: document.getElementById("tileChecked"),
  tileCheckedLabel: document.getElementById("tileCheckedLabel"),
  tileRejected: document.getElementById("tileRejected"),
  tileRejectedLabel: document.getElementById("tileRejectedLabel"),
  tileResult: document.getElementById("tileResult"),
  tileRunId: document.getElementById("tileRunId"),
  monitorLogInfo: document.getElementById("monitorLogInfo"),
  monitorLog: document.getElementById("monitorLog"),
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
  jobHistory: document.getElementById("jobHistory"),
  doctorLine: document.getElementById("doctorLine"),
  reviewerQueue: document.getElementById("reviewerQueue"),
  reviewerMaxManuscripts: document.getElementById("reviewerMaxManuscripts"),
  reviewersPerPaper: document.getElementById("reviewersPerPaper"),
  reviewerStartUrl: document.getElementById("reviewerStartUrl"),
  reviewerSlowMo: document.getElementById("reviewerSlowMo"),
  reviewerRefreshWaitSeconds: document.getElementById("reviewerRefreshWaitSeconds"),
  reviewerKeepOpen: document.getElementById("reviewerKeepOpen"),
  reviewerBatchSummary: document.getElementById("reviewerBatchSummary"),
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
  screeningApproveWithoutAssign: document.getElementById("screeningApproveWithoutAssign"),
  screeningDryRunBtn: document.getElementById("screeningDryRunBtn"),
  screeningLiveRunBtn: document.getElementById("screeningLiveRunBtn"),
  saveScreeningSettingsBtn: document.getElementById("saveScreeningSettingsBtn"),
  screeningSettingsStatus: document.getElementById("screeningSettingsStatus"),
  screeningRunSelect: document.getElementById("screeningRunSelect"),
  screeningDecisionFilter: document.getElementById("screeningDecisionFilter"),
  screeningRunSummary: document.getElementById("screeningRunSummary"),
  screeningResultsBody: document.getElementById("screeningResultsBody"),
  refreshScreeningRunsBtn: document.getElementById("refreshScreeningRunsBtn"),
  screeningRunSelection: document.getElementById("screeningRunSelection"),
  executeRunBtn: document.getElementById("executeRunBtn"),
};

els.rejectTab.addEventListener("click", () => activateView("reject"));
els.screeningTab.addEventListener("click", () => activateView("screening"));
els.reviewersTab.addEventListener("click", () => activateView("reviewers"));
els.monitorTab.addEventListener("click", () => activateView("monitor"));
const workflowTabs = [
  { view: "reject", tab: els.rejectTab },
  { view: "screening", tab: els.screeningTab },
  { view: "reviewers", tab: els.reviewersTab },
  { view: "monitor", tab: els.monitorTab },
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
bindAsyncClick(els.inviteReviewersBtn, runReviewerBatch);
bindAsyncClick(els.saveReviewerSettingsBtn, saveReviewerSettings);
bindAsyncClick(els.screeningDryRunBtn, runMetadataCollection);
bindAsyncClick(els.screeningLiveRunBtn, runLiveAssessment);
bindAsyncClick(els.saveScreeningSettingsBtn, saveScreeningSettings);

els.monitorRunSelect.addEventListener("change", () => selectMonitorRun().catch(showError));
els.screeningRunSelect?.addEventListener("change", () => loadScreeningRun().catch(showError));
els.screeningDecisionFilter?.addEventListener("change", renderScreeningResults);
if (els.refreshScreeningRunsBtn) bindAsyncClick(els.refreshScreeningRunsBtn, refreshScreeningRuns);
if (els.executeRunBtn) bindAsyncClick(els.executeRunBtn, executeSelectedRun);

refresh().catch(showError);
refreshDoctor().catch(() => undefined);
refreshScreeningRuns().catch(() => undefined);
startRunMonitor();
refreshJobHistory().catch(() => undefined);

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

// Joby przeżywają restart panelu (logs/jobs/), więc "co i kiedy odpalałem"
// jest dostępne bez grzebania w logach.
// Ta sama ścieżka bezpieczeństwa co reject z raportu: obejrzyj wynik, potem
// wykonaj. Model nie jest pytany ponownie — wykonywane są dokładnie te decyzje,
// które widać w tabeli.
async function executeSelectedRun() {
  const run = state.screeningRun;
  const filename = els.screeningRunSelect?.value;
  if (!run || !filename) {
    showError(new Error("Select a saved run first."));
    return;
  }

  const pending = run.manuscripts.filter(
    (row) => row.decision && !row.assessmentError && !row.actionCompleted
  );
  if (pending.length === 0) {
    showError(new Error("This run has no decisions left to execute."));
    return;
  }

  const approve = pending.filter((row) => row.decision === "APPROVE").length;
  const reject = pending.filter((row) => row.decision === "REJECT").length;
  const approveWithoutAssign = els.screeningApproveWithoutAssign.checked;
  const approveNote = approveWithoutAssign
    ? "approved papers will be left in Awaiting EIC Assignment for manual editor assignment"
    : "approved papers will be assigned to the configured editor";

  if (!confirmDangerousAction(
    `Execute ${pending.length} decisions from this run?\n\nAPPROVE: ${approve}\nREJECT: ${reject}\n\nRejection emails will be sent and ${approveNote}.`
  )) {
    return;
  }

  const payload = await api("/api/run/screening/execute", {
    method: "POST",
    body: JSON.stringify({
      run: filename,
      screeningApproveWithoutAssign: approveWithoutAssign,
    }),
  });
  setJob(payload.job);
}

async function refreshJobHistory() {
  if (!els.jobHistory) return;

  const { jobs } = await api("/api/jobs");
  els.jobHistory.replaceChildren();

  if (jobs.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No saved runs yet.";
    els.jobHistory.append(empty);
    return;
  }

  for (const job of jobs) {
    const item = document.createElement("li");
    item.dataset.status = job.status;

    const when = document.createElement("span");
    when.className = "job-history-when";
    when.textContent = job.startedAt ? formatReportDate(job.startedAt) : "—";

    const what = document.createElement("span");
    what.className = "job-history-what";
    what.textContent = job.type;

    const outcome = document.createElement("span");
    outcome.className = "job-history-outcome";
    outcome.textContent = describeJobOutcome(job);

    item.append(when, what, outcome);
    els.jobHistory.append(item);
  }
}

function describeJobOutcome(job) {
  const progress = job.progress || {};
  const parts = [job.status];
  if (progress.sent) parts.push(`sent ${progress.sent}`);
  if (progress.checked) parts.push(`checked ${progress.checked}`);
  if (progress.errors) parts.push(`errors ${progress.errors}`);
  return parts.join(" · ");
}

async function refreshScreeningRuns() {
  if (!els.screeningRunSelect) return;

  const { runs } = await api("/api/screening/runs");
  state.screeningRuns = runs;
  els.screeningRunSelect.replaceChildren();

  if (runs.length === 0) {
    els.screeningRunSummary.textContent = "No saved runs";
    els.screeningResultsBody.replaceChildren();
    return;
  }

  for (const run of runs) {
    const option = document.createElement("option");
    option.value = run.filename;
    const when = run.createdAt ? formatReportDate(run.createdAt) : run.runId;
    option.textContent = `${when} · ${run.manuscriptCount} papers${run.live ? " · live" : ""}`;
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
  const pending = run.manuscripts.filter(
    (row) => row.decision && !row.assessmentError && !row.actionCompleted
  ).length;

  if (els.screeningRunSelection) {
    els.screeningRunSelection.textContent = pending
      ? `${pending} decisions ready to execute`
      : "Nothing left to execute in this run";
  }
  if (els.executeRunBtn) {
    els.executeRunBtn.disabled = pending === 0 ||
      Boolean(state.currentJob && ["running", "stopping"].includes(state.currentJob.status));
  }

  els.screeningRunSummary.textContent = [
    `${run.manuscripts.length} papers`,
    summary.approved !== undefined ? `APPROVE ${summary.approved}` : null,
    summary.rejected !== undefined ? `REJECT ${summary.rejected}` : null,
    summary.assessmentErrors ? `errors ${summary.assessmentErrors}` : null,
    run.live ? "live" : "dry run",
  ].filter(Boolean).join(" · ");

  els.screeningResultsBody.replaceChildren();

  if (rows.length === 0) {
    const empty = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No results for this filter.";
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
  label.textContent = "abstract";
  const abstract = document.createElement("p");
  abstract.className = "row-abstract";
  abstract.textContent = row.abstract || "(none)";
  details.append(label, abstract);
  idCell.append(id, title, details);

  const decisionCell = document.createElement("td");
  decisionCell.textContent = row.decision || (row.assessmentError ? "ERROR" : "—");
  decisionCell.dataset.decision = row.decision || (row.assessmentError ? "ERROR" : "");
  if (row.cached) decisionCell.title = "result from cache";

  const reasonCell = document.createElement("td");
  reasonCell.textContent = row.assessmentError || row.reason || "—";

  const tokensCell = document.createElement("td");
  tokensCell.className = "numeric";
  tokensCell.textContent = row.cached ? "cache" : (row.totalTokens ?? "—");

  const actionCell = document.createElement("td");
  actionCell.textContent = row.actionError
    ? `failed: ${row.actionError}`
    : row.actionCompleted
      ? `done: ${row.actionDecision}`
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
    showError(new Error("Select a report from the table."));
    return;
  }
  if (!validateInputs([els.startUrl, els.olderDays, els.slowMo, els.maxRejected])) {
    return;
  }
  if (!confirmDangerousAction(`Reject the candidates from this report?\n\n${state.selectedReportPath}`)) {
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
    ? "the entire Complete Checklist queue"
    : `at most ${valueOf(els.screeningMaxChecked)} manuscripts`;
  const approveNote = els.screeningApproveWithoutAssign.checked
    ? "approved papers will be left in Awaiting EIC Assignment for manual editor assignment (revisions are still fully assigned)"
    : "approved papers will be assigned to the configured editor as EIC and AE";
  if (!confirmDangerousAction(
    `Run LIVE over ${scope}?\n\nAPPROVE and REJECT will really be performed in ScholarOne. Rejection emails will be sent and ${approveNote}.`
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
      refreshJobHistory().catch(() => undefined);
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
  if (progress.checked) parts.push(`checked: ${progress.checked}`);
  if (progress.currentManuscriptId) parts.push(progress.currentManuscriptId);

  const approve = progress.decisions?.APPROVE || 0;
  const reject = progress.decisions?.REJECT || 0;
  if (approve || reject) parts.push(`APPROVE ${approve} / REJECT ${reject}`);
  if (progress.sent) parts.push(`sent: ${progress.sent}`);
  if (progress.liveActions) {
    parts.push(`live actions: ${progress.liveActions}${progress.liveActionLimit ? `/${progress.liveActionLimit}` : ""}`);
  }
  if (progress.cacheHits) parts.push(`cache: ${progress.cacheHits}`);
  if (progress.skipped) parts.push(`skipped: ${progress.skipped}`);
  if (progress.errors) parts.push(`errors: ${progress.errors}`);
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
  els.inviteReviewersBtn.disabled = jobRunning;
  els.screeningDryRunBtn.disabled = jobRunning;
  els.screeningLiveRunBtn.disabled = jobRunning;
  if (els.executeRunBtn) {
    const run = state.screeningRun;
    const pending = run
      ? run.manuscripts.filter((row) => row.decision && !row.assessmentError && !row.actionCompleted).length
      : 0;
    els.executeRunBtn.disabled = jobRunning || pending === 0;
  }
}

function activateView(view) {
  state.activeView = view;
  const views = [
    { name: "reject", tab: els.rejectTab, panel: els.rejectPanel },
    { name: "screening", tab: els.screeningTab, panel: els.screeningPanel },
    { name: "reviewers", tab: els.reviewersTab, panel: els.reviewersPanel },
    { name: "monitor", tab: els.monitorTab, panel: els.monitorPanel },
  ];
  for (const item of views) {
    const active = item.name === view;
    item.panel.hidden = !active;
    item.tab.classList.toggle("selected", active);
    item.tab.setAttribute("aria-selected", String(active));
    item.tab.tabIndex = active ? 0 : -1;
  }
  if (view === "monitor") {
    refreshMonitorHistory().catch(() => undefined);
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
  els.screeningApproveWithoutAssign.checked = Boolean(config.screeningApproveWithoutAssign);
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
    screeningApproveWithoutAssign: els.screeningApproveWithoutAssign.checked,
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
  return window.confirm(`${message}\n\nThis cannot be undone in ScholarOne.`);
}

// --- Run monitor (zakładka Monitor) ---
// Pokazuje puls z logs/current-run.json niezależnie od tego, czy przebieg
// wystartował z panelu, z CLI, czy przez agenta.

function startRunMonitor() {
  pollRunMonitor();
  refreshMonitorHistory().catch(() => undefined);
  setInterval(pollRunMonitor, MONITOR_POLL_MS);
  setInterval(renderMonitorClocks, MONITOR_TICK_MS);
}

async function pollRunMonitor() {
  try {
    const payload = await api(`/api/cli-run?tail=${MONITOR_TAIL}`);
    monitorState.run = payload.run || null;
    monitorState.events = payload.events || [];
    monitorState.offline = false;
    monitorState.offlineMessage = "";
  } catch (error) {
    monitorState.offline = true;
    monitorState.offlineMessage = error.message;
  }

  // Świeżo zakończony przebieg od razu pojawia się na liście historii.
  const liveStatus = monitorState.run?.effectiveStatus || null;
  if (liveStatus !== monitorState.lastLiveStatus) {
    monitorState.lastLiveStatus = liveStatus;
    if (["finished", "failed", "dead"].includes(liveStatus)) {
      refreshMonitorHistory().catch(() => undefined);
    }
  }

  renderMonitor();
}

async function refreshMonitorHistory() {
  const { runs } = await api("/api/cli-run/history");
  const select = els.monitorRunSelect;
  const previous = select.value || "live";
  select.replaceChildren();

  const live = document.createElement("option");
  live.value = "live";
  live.textContent = "Live: follow current run";
  select.append(live);

  for (const run of runs) {
    if (run.status === "running") continue;
    const option = document.createElement("option");
    option.value = run.filename;
    option.textContent = monitorHistoryLabel(run);
    select.append(option);
  }

  const stillExists = Array.from(select.options).some((option) => option.value === previous);
  select.value = stillExists ? previous : "live";
  if (!stillExists) {
    monitorState.view = "live";
    monitorState.archive = null;
    renderMonitor();
  }
}

function monitorHistoryLabel(run) {
  const parts = [formatReportDate(run.startedAt)];
  if (run.mode) parts.push(run.mode);
  parts.push(
    run.status === "finished" && run.resultStatus
      ? run.resultStatus.replaceAll("_", " ")
      : run.status
  );
  return parts.join(" · ");
}

async function selectMonitorRun() {
  const value = els.monitorRunSelect.value;
  if (value === "live") {
    monitorState.view = "live";
    monitorState.archive = null;
    renderMonitor();
    return;
  }

  const payload = await api(`/api/cli-run/history/${encodeURIComponent(value)}?tail=2000`);
  monitorState.view = "archive";
  monitorState.archive = payload;
  renderMonitor();
}

function renderMonitor() {
  if (monitorState.view === "archive" && monitorState.archive) {
    renderArchivedMonitor();
    return;
  }
  renderBeacon();
  renderMonitorTiles();
  renderMonitorLog();
}

function renderArchivedMonitor() {
  const { run, events, totalEvents } = monitorState.archive;
  const dotState = run.status === "finished" ? "finished" : "bad";
  const statusLabel =
    run.status === "finished" ? "Finished" : run.status === "failed" ? "Failed" : "Interrupted";

  setBeacon(
    dotState,
    statusLabel,
    `Saved run from ${formatReportDate(run.startedAt)}. Select "Live" to follow the current run again.`
  );
  els.factHeartbeatLabel.textContent = "Finished";
  setMonitorFacts({
    mode: run.mode,
    pid: null,
    started: formatReportDate(run.startedAt),
    heartbeat: run.finishedAt ? formatReportDate(run.finishedAt) : null,
  });

  renderCountTiles(run);
  setMonitorText(
    els.tileResult,
    run.resultStatus ? run.resultStatus.replaceAll("_", " ") : statusLabel.toLowerCase()
  );
  setMonitorText(els.tileRunId, run.runId);

  const truncated = totalEvents > events.length ? `last ${events.length} of ${totalEvents}` : `all ${events.length}`;
  renderMonitorEvents(events, `archive:${run.filename}`, `${truncated} events from ${run.filename}`, {
    emptyText: "This log has no readable events.",
    stickToBottom: false,
  });
}

function renderBeacon() {
  els.factHeartbeatLabel.textContent = "Heartbeat";
  if (monitorState.offline) {
    setBeacon("offline", "Offline", `UI server unreachable: ${monitorState.offlineMessage}`);
    return;
  }

  const run = monitorState.run;
  if (!run) {
    setBeacon("idle", "Idle", "No run yet. Start one from a workflow tab or the CLI.");
    setMonitorFacts({});
    return;
  }

  const quietSeconds = secondsSince(run.updatedAt);
  if (run.effectiveStatus === "running") {
    if (quietSeconds !== null && quietSeconds > MONITOR_QUIET_AFTER_SECONDS) {
      setBeacon("quiet", "Running", `Process is alive, but the log is quiet for ${formatQuietSeconds(quietSeconds)}. It may wait for login or a slow page.`);
    } else {
      setBeacon("running", "Running", "Process is alive and reporting.");
    }
  } else if (run.effectiveStatus === "finished") {
    setBeacon("finished", "Finished", `Run completed ${relativeTime(run.finishedAt || run.updatedAt)}.`);
  } else if (run.effectiveStatus === "failed") {
    setBeacon("bad", "Failed", `Run failed ${relativeTime(run.finishedAt || run.updatedAt)}. Check the event log below.`);
  } else if (run.effectiveStatus === "dead") {
    setBeacon("bad", "Interrupted", "The run says it is active, but the process is gone (killed or crashed).");
  } else {
    setBeacon("idle", String(run.effectiveStatus || run.status || "Unknown"), "");
  }

  setMonitorFacts({
    mode: run.mode,
    pid: run.pid,
    started: relativeTime(run.startedAt),
    heartbeat: relativeTime(run.updatedAt),
  });
}

function setBeacon(stateName, statusText, noteText) {
  els.beaconDot.dataset.state = stateName;
  els.beaconStatus.textContent = statusText;
  els.beaconNote.textContent = noteText;
}

function setMonitorFacts(facts) {
  setMonitorText(els.factMode, facts.mode);
  setMonitorText(els.factPid, facts.pid);
  setMonitorText(els.factStarted, facts.started);
  setMonitorText(els.factHeartbeat, facts.heartbeat);
}

function renderMonitorTiles() {
  const run = monitorState.offline ? null : monitorState.run;
  renderCountTiles(run);
  setMonitorText(els.tileResult, run?.resultStatus ? run.resultStatus.replaceAll("_", " ") : null);
  setMonitorText(els.tileRunId, run ? run.runId : null);
}

// Przebieg recenzentów nie odrzuca artykułów, więc pierwsze dwa kafelki
// pokazują jego właściwy postęp: obrobione artykuły i wysłane zaproszenia.
function renderCountTiles(run) {
  if (run?.mode === "reviewers") {
    els.tileCheckedLabel.textContent = "Papers";
    els.tileRejectedLabel.textContent = "Invited";
    const done = Number.isFinite(run.papersDone) ? run.papersDone : null;
    const requested = Number.isFinite(run.papersRequested) ? run.papersRequested : null;
    setMonitorText(els.tileChecked, done === null ? null : requested ? `${done} / ${requested}` : done);
    setMonitorText(els.tileRejected, run.invited);
    return;
  }

  els.tileCheckedLabel.textContent = "Checked";
  els.tileRejectedLabel.textContent = "Rejected";
  setMonitorText(els.tileChecked, run ? run.checked : null);
  setMonitorText(els.tileRejected, run ? run.rejected : null);
}

function renderMonitorLog() {
  if (monitorState.offline) {
    els.monitorLogInfo.textContent = "connection lost, retrying…";
    return;
  }

  const runId = monitorState.run?.runId || null;
  const info = monitorState.run?.logFile
    ? `tail of ${monitorState.run.logFile}`
    : "tail of the run log";
  renderMonitorEvents(monitorState.events, `live:${runId}`, info, {
    emptyText: monitorState.run ? "No events yet." : "No run data yet.",
    stickToBottom: true,
  });
}

// Wspólny renderer dla widoku live i archiwum. renderKey rozróżnia źródła,
// więc przełączenie przebiegu zawsze przebudowuje listę, a kolejne odpytania
// tego samego przebiegu nie ruszają DOM bez zmian.
function renderMonitorEvents(events, renderKey, infoText, { emptyText, stickToBottom }) {
  els.monitorLogInfo.textContent = infoText;

  const unchanged =
    renderKey === monitorState.renderedRunId &&
    events.length === monitorState.renderedEventCount;
  if (unchanged) {
    return;
  }

  const firstRender =
    monitorState.renderedEventCount === -1 || renderKey !== monitorState.renderedRunId;
  const wasAtBottom =
    els.monitorLog.scrollTop + els.monitorLog.clientHeight >= els.monitorLog.scrollHeight - 8;
  monitorState.renderedRunId = renderKey;
  monitorState.renderedEventCount = events.length;

  els.monitorLog.replaceChildren();

  if (events.length === 0) {
    const empty = document.createElement("p");
    empty.className = "log-empty";
    empty.textContent = emptyText;
    els.monitorLog.append(empty);
    return;
  }

  for (const event of events) {
    els.monitorLog.append(monitorLogRow(event));
  }

  if (stickToBottom && (firstRender || wasAtBottom)) {
    els.monitorLog.scrollTop = els.monitorLog.scrollHeight;
  } else if (firstRender) {
    // Archiwum czyta się od początku przebiegu.
    els.monitorLog.scrollTop = 0;
  }
}

function monitorLogRow(event) {
  const row = document.createElement("div");
  row.className = "log-row";
  row.dataset.tone = monitorEventTone(event.type);

  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = monitorEventTime(event.at);

  const type = document.createElement("span");
  type.className = "log-type";
  type.textContent = event.type || "";

  const text = document.createElement("span");
  text.className = "log-text";
  if (event.manuscriptId) {
    const id = document.createElement("span");
    id.className = "log-id";
    id.textContent = event.manuscriptId;
    text.append(id, document.createTextNode("  "));
  }
  text.append(document.createTextNode(monitorEventDetails(event)));

  row.append(time, type, text);
  return row;
}

function monitorEventTone(type) {
  if (!type) {
    return "default";
  }
  if (/rejected_and_sent|run_finished|succeeded|invite_confirmed|^sent$/i.test(type)) {
    return "ok";
  }
  if (/fail|error|not_found|mismatch|loop_detected|limit_reached/i.test(type)) {
    return "bad";
  }
  if (/login|stopped|skip|duplicate|not_actionable|unavailable/i.test(type)) {
    return "warn";
  }
  return "default";
}

function monitorEventDetails(event) {
  const parts = [];
  if (event.status) parts.push(event.status);
  if (event.reason) parts.push(event.reason);
  if (event.message) parts.push(event.message);
  if (event.note) parts.push(event.note);

  const counters = [];
  if (Number.isFinite(event.checked)) counters.push(`checked ${event.checked}`);
  if (Number.isFinite(event.rejected)) counters.push(`rejected ${event.rejected}`);
  if (counters.length) parts.push(`(${counters.join(", ")})`);

  return parts.join(" · ").replace(/\s+/g, " ").trim();
}

function renderMonitorClocks() {
  if (monitorState.view !== "live" || monitorState.offline || !monitorState.run) {
    return;
  }
  setMonitorText(els.factStarted, relativeTime(monitorState.run.startedAt));
  setMonitorText(els.factHeartbeat, relativeTime(monitorState.run.updatedAt));
}

function setMonitorText(element, value) {
  element.textContent = value === undefined || value === null || value === "" ? "—" : String(value);
}

function monitorEventTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function secondsSince(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
}

function formatQuietSeconds(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)} min ${seconds % 60}s`;
}

function relativeTime(value) {
  const seconds = secondsSince(value);
  if (seconds === null) {
    return null;
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min ago`;
  }
  return new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}
