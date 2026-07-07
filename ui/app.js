const state = {
  reports: [],
  selectedReportPath: "",
  currentJob: null,
  pollTimer: null,
  configApplied: false,
};

const els = {
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
};

els.refreshBtn.addEventListener("click", refresh);
els.dryRunBtn.addEventListener("click", runDryRun);
els.liveRunBtn.addEventListener("click", runLiveSend);
els.sendReportBtn.addEventListener("click", sendSelectedReport);
els.saveSettingsBtn.addEventListener("click", saveSettings);
els.resetSettingsBtn.addEventListener("click", resetSettings);
els.stopBtn.addEventListener("click", stopCurrentJob);

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
  const payload = await api("/api/run/dryrun", {
    method: "POST",
    body: JSON.stringify(scanOptions({ includeMaxRejected: false })),
  });
  setJob(payload.job);
}

async function runLiveSend() {
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
    cell.colSpan = 6;
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
    if (report.path === state.selectedReportPath) {
      row.classList.add("selected");
    }
    row.addEventListener("click", () => {
      state.selectedReportPath = report.path;
      renderReports();
      updateActionState();
    });

    row.append(
      reportNameCell(report),
      textCell(report.status || "-"),
      textCell(String(report.checked)),
      countCell(report.candidates),
      countCell(report.progressRejected),
      textCell(progressText(report)),
    );
    els.reportsBody.append(row);
  }

  renderSelectedReport();
}

function reportNameCell(report) {
  const cell = document.createElement("td");
  const name = document.createElement("div");
  name.textContent = report.filename;
  const path = document.createElement("div");
  path.className = "path";
  path.textContent = report.path;
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
  if (report.progressRejected) parts.push(`rejected ${report.progressRejected}`);
  if (report.progressSkipped) parts.push(`skipped ${report.progressSkipped}`);
  return parts.length ? parts.join(", ") : "-";
}

function renderSelectedReport() {
  const report = state.reports.find((item) => item.path === state.selectedReportPath);
  if (!report) {
    els.selectedReport.textContent = "No report selected";
    return;
  }
  els.selectedReport.textContent = `${report.filename}: ${report.candidates || 0} candidates, ${report.progressRejected || 0} rejected`;
}

function renderJob() {
  const job = state.currentJob;
  if (!job) {
    els.statusLine.textContent = "Ready";
    els.jobOutput.textContent = "No active job.";
    els.stopBtn.disabled = true;
    return;
  }

  const status = `${job.type} ${job.status}`;
  els.statusLine.textContent = job.exitCode === null ? status : `${status}, exit ${job.exitCode}`;
  els.jobOutput.textContent = job.output || "Job started...";
  els.jobOutput.scrollTop = els.jobOutput.scrollHeight;
  els.stopBtn.disabled = !["running", "stopping"].includes(job.status);
}

function updateActionState() {
  const jobRunning = state.currentJob && ["running", "stopping"].includes(state.currentJob.status);
  els.dryRunBtn.disabled = jobRunning;
  els.liveRunBtn.disabled = jobRunning;
  els.sendReportBtn.disabled = jobRunning || !state.selectedReportPath;
}

function showError(error) {
  els.statusLine.textContent = error.message;
  console.error(error);
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
  els.settingsStatus.textContent = config.settingsSaved
    ? `Saved: ${config.settingsPath}`
    : "Loaded from .env/defaults";
}

function setValue(input, value) {
  if (value !== undefined && value !== null) {
    input.value = value;
  }
}

function scanOptions({ includeMaxRejected }) {
  return {
    startUrl: valueOf(els.startUrl),
    maxChecked: valueOf(els.maxChecked),
    submittedOlderThanDays: valueOf(els.olderDays),
    queueStartPage: valueOf(els.queuePage),
    slowMo: valueOf(els.slowMo),
    keepOpen: els.keepOpen.checked,
    rejectMessage: valueOf(els.rejectMessage),
    ...(includeMaxRejected ? { maxRejected: valueOf(els.maxRejected) } : {}),
  };
}

function sendOptions() {
  return {
    startUrl: valueOf(els.startUrl),
    submittedOlderThanDays: valueOf(els.olderDays),
    slowMo: valueOf(els.slowMo),
    maxRejected: valueOf(els.maxRejected),
    keepOpen: els.keepOpen.checked,
    rejectMessage: valueOf(els.rejectMessage),
  };
}

function settingsOptions() {
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
