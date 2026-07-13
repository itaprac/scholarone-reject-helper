const state = {
  reports: [],
  selectedReportPath: "",
  currentJob: null,
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
  reviewersTab: document.getElementById("reviewersTab"),
  rejectPanel: document.getElementById("rejectPanel"),
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
};

els.rejectTab.addEventListener("click", () => activateView("reject"));
els.reviewersTab.addEventListener("click", () => activateView("reviewers"));
for (const tab of [els.rejectTab, els.reviewersTab]) {
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const nextView = state.activeView === "reject" ? "reviewers" : "reject";
    activateView(nextView);
    (nextView === "reviewers" ? els.reviewersTab : els.rejectTab).focus();
  });
}
els.reviewerMaxManuscripts.addEventListener("input", renderReviewerBatchSummary);
els.reviewersPerPaper.addEventListener("input", renderReviewerBatchSummary);
els.reviewerQueue.addEventListener("change", renderReviewerBatchSummary);
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

refresh().catch(showError);

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

  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  if (job && ["running", "stopping"].includes(job.status)) {
    state.pollTimer = setInterval(pollJob, 1500);
  }
}

async function pollJob() {
  if (!state.currentJob?.id) {
    return;
  }

  try {
    const payload = await api(`/api/jobs/${state.currentJob.id}`);
    setJob(payload.job);
    if (!payload.job || !["running", "stopping"].includes(payload.job.status)) {
      await refresh();
    }
  } catch (error) {
    showError(error);
  }
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
    els.stopBtn.disabled = true;
    return;
  }

  const status = `${job.type} ${job.status}`;
  els.statusLine.textContent = job.exitCode === null ? status : `${status}, exit ${job.exitCode}`;
  els.statusLine.dataset.tone = job.status === "failed" ? "error" : "active";
  els.jobOutput.textContent = job.output || "Job started...";
  els.jobOutput.scrollTop = els.jobOutput.scrollHeight;
  els.stopBtn.disabled = !["running", "stopping"].includes(job.status);
}

function updateActionState() {
  const jobRunning = state.currentJob && ["running", "stopping"].includes(state.currentJob.status);
  els.dryRunBtn.disabled = jobRunning;
  els.liveRunBtn.disabled = jobRunning;
  els.sendReportBtn.disabled = jobRunning || !state.selectedReportPath;
  els.prepareReviewersBtn.disabled = jobRunning;
  els.inviteReviewersBtn.disabled = jobRunning;
}

function activateView(view) {
  state.activeView = view;
  const reviewersActive = view === "reviewers";
  els.rejectPanel.hidden = reviewersActive;
  els.reviewersPanel.hidden = !reviewersActive;
  els.rejectTab.classList.toggle("selected", !reviewersActive);
  els.reviewersTab.classList.toggle("selected", reviewersActive);
  els.rejectTab.setAttribute("aria-selected", String(!reviewersActive));
  els.reviewersTab.setAttribute("aria-selected", String(reviewersActive));
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
  renderReviewerBatchSummary();
  const settingsStatus = config.settingsSaved
    ? `Saved: ${config.settingsPath}`
    : "Loaded from .env/defaults";
  els.settingsStatus.textContent = settingsStatus;
  els.reviewerSettingsStatus.textContent = settingsStatus;
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
  };
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
