// Shared client core for the Desk and Ledger layouts.
//
// Owns everything that talks to the UI server: settings values, job start and
// streaming, saved runs, reports, ScholarOne queue counts and the CLI run
// monitor. Layouts subscribe to events and only render.

window.S1 = (() => {
  const MONITOR_POLL_MS = 2500;
  const QUEUE_STALE_MS = 5 * 60 * 1000;
  const SAVE_DEBOUNCE_MS = 900;

  const listeners = new Map();
  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event).delete(handler);
  }
  function emit(event, payload) {
    for (const handler of listeners.get(event) || []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(error);
      }
    }
  }

  const state = {
    config: null,
    values: {},
    settingsNote: "",
    reports: [],
    job: null,
    jobs: [],
    stream: null,
    pollTimer: null,
    queues: null,
    queuesLoading: false,
    cliRun: null,
    cliEvents: [],
    cliOffline: false,
    cliHistory: [],
    runs: { initial: [], eic: [] },
    runDetails: new Map(),
    doctorProblems: [],
  };

  // --- Workflow definitions -------------------------------------------------
  // Field keys equal the config keys returned by /api/state and the option
  // keys accepted by /api/settings and /api/run/*.

  const URL_FIELD = (key) => ({ key, label: "Start URL", type: "url", wide: true, required: true });
  const SLOW_FIELD = (key) => ({ key, label: "Slow ms", type: "number", min: 0 });
  const EFFORT = ["low", "medium", "high"];

  const WORKFLOWS = [
    {
      key: "reject",
      name: "Auto-reject",
      short: "Reject",
      queue: "Complete Checklist",
      summary: "Reject stale or flagged submissions by rule. No model involved.",
      dryLabel: "Run dry run",
      liveLabel: "Run + reject",
      liveNote: "Sends rejection emails while scanning.",
      fields: [
        { key: "maxChecked", label: "Max checked", type: "number", min: 1, required: true },
        { key: "submittedOlderThanDays", label: "Older than days", type: "number", min: 1, required: true },
        { key: "maxRejected", label: "Max rejected", type: "number", min: 1, placeholder: "no limit" },
      ],
      advanced: [
        URL_FIELD("startUrl"),
        { key: "queueStartPage", label: "Queue page", type: "number", min: 1, placeholder: "auto" },
        SLOW_FIELD("slowMo"),
      ],
      checks: [{ key: "keepOpen", label: "Keep browser open after the run" }],
      texts: [{ key: "rejectMessage", label: "Reject email body", rows: 12 }],
      optionKeys: ["startUrl", "maxChecked", "submittedOlderThanDays", "queueStartPage", "slowMo", "maxRejected", "keepOpen", "rejectMessage"],
    },
    {
      key: "screening",
      name: "Initial assessment",
      short: "Initial",
      queue: "Complete Checklist",
      stage: "initial",
      summary: "Collect title and abstract from Complete Checklist, assess each paper with Codex, save one batch.",
      dryLabel: "Run assessment dry run",
      liveLabel: "Run live decisions",
      liveNote: "Approves and rejects in ScholarOne as the model decides.",
      fields: [
        { key: "screeningScanAll", label: "Scan scope", type: "scope" },
        { key: "screeningMaxChecked", label: "Safety limit", type: "number", min: 1, max: 100 },
        { key: "assessmentModel", label: "Codex model", type: "text", required: true },
        { key: "assessmentReasoningEffort", label: "Reasoning effort", type: "select", choices: EFFORT },
      ],
      advanced: [
        URL_FIELD("screeningStartUrl"),
        SLOW_FIELD("screeningSlowMo"),
        { key: "assessmentTimeoutSeconds", label: "LLM timeout (s)", type: "number", min: 10, max: 600 },
      ],
      checks: [{ key: "screeningApproveWithoutAssign", label: "Approve without assigning editors (approved papers wait in Awaiting EIC Assignment)" }],
      texts: [
        { key: "assessmentPrompt", label: "Assessment rules", rows: 14 },
        { key: "screeningRejectMessage", label: "Live rejection email", rows: 9 },
      ],
      optionKeys: ["screeningStartUrl", "screeningMaxChecked", "screeningScanAll", "screeningSlowMo", "assessmentModel", "assessmentReasoningEffort", "assessmentTimeoutSeconds", "assessmentPrompt", "screeningRejectMessage", "screeningApproveWithoutAssign"],
    },
    {
      key: "eic",
      name: "EIC assessment",
      short: "EIC",
      queue: "Awaiting EIC Assignment",
      stage: "eic",
      summary: "Second, stricter assessment of Awaiting EIC Assignment. Both decisions assign EIC and AE first.",
      dryLabel: "Run second assessment dry run",
      liveLabel: "Run live decisions",
      liveNote: "REJECT submits “Reject - Fatally Flawed” and emails the author.",
      fields: [
        { key: "eicAssessmentScanAll", label: "Scan scope", type: "scope" },
        { key: "eicAssessmentMaxChecked", label: "Safety limit", type: "number", min: 1, max: 100 },
        { key: "eicAssessmentModel", label: "Codex model", type: "text", required: true },
        { key: "eicAssessmentReasoningEffort", label: "Reasoning effort", type: "select", choices: EFFORT },
      ],
      advanced: [
        URL_FIELD("eicAssessmentStartUrl"),
        SLOW_FIELD("eicAssessmentSlowMo"),
        { key: "eicAssessmentTimeoutSeconds", label: "LLM timeout (s)", type: "number", min: 10, max: 600 },
      ],
      checks: [],
      texts: [
        { key: "eicAssessmentPrompt", label: "Second assessment rules", rows: 14 },
        { key: "eicAssessmentRejectMessage", label: "Live rejection email", rows: 9 },
      ],
      optionKeys: ["eicAssessmentStartUrl", "eicAssessmentMaxChecked", "eicAssessmentScanAll", "eicAssessmentSlowMo", "eicAssessmentModel", "eicAssessmentReasoningEffort", "eicAssessmentTimeoutSeconds", "eicAssessmentPrompt", "eicAssessmentRejectMessage"],
    },
    {
      key: "reviewers",
      name: "Reviewers",
      short: "Reviewers",
      queue: "Select Reviewers",
      summary: "Pick reviewers for each paper and send invitations, one paper at a time.",
      dryLabel: null,
      liveLabel: "Invite reviewers",
      liveNote: "Sends real invitation emails. Each paper is verified before the next one starts.",
      fields: [
        { key: "reviewerQueue", label: "Source queue", type: "select", choices: ["combined", "select", "invite"], labels: { combined: "Combined: Invite, then Select", select: "Select Reviewers", invite: "Invite Reviewers" } },
        { key: "reviewerMaxManuscripts", label: "Papers this run", type: "number", min: 1, required: true },
        { key: "reviewersPerPaper", label: "Reviewers per paper", type: "number", min: 1, required: true },
      ],
      advanced: [
        URL_FIELD("reviewerStartUrl"),
        SLOW_FIELD("reviewerSlowMo"),
        { key: "reviewerRefreshWaitSeconds", label: "Refresh wait (s)", type: "number", min: 1, max: 3600 },
      ],
      checks: [{ key: "reviewerKeepOpen", label: "Keep browser open after the run" }],
      texts: [],
      optionKeys: ["reviewerStartUrl", "reviewerQueue", "reviewerMaxManuscripts", "reviewersPerPaper", "reviewerSlowMo", "reviewerRefreshWaitSeconds", "reviewerKeepOpen"],
    },
  ];

  const JOB_LABELS = {
    dryrun: "Auto-reject, dry run",
    "live-reject": "Auto-reject, live",
    "reject-from-report": "Auto-reject, from report",
    "reviewers-invite": "Reviewers, invite",
    "initial-assessment-dryrun": "Initial assessment, dry run",
    "initial-assessment-live": "Initial assessment, live",
    "initial-assessment-from-run": "Initial assessment, execute run",
    "eic-assessment-dryrun": "EIC assessment, dry run",
    "eic-assessment-live": "EIC assessment, live",
    "eic-assessment-from-run": "EIC assessment, execute run",
  };

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

  function workflow(key) {
    return WORKFLOWS.find((item) => item.key === key);
  }

  // --- HTTP -----------------------------------------------------------------

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  }

  // --- Settings values --------------------------------------------------------

  function valuesFromConfig(config) {
    const values = {};
    for (const wf of WORKFLOWS) {
      for (const key of wf.optionKeys) {
        const raw = config[key];
        values[key] = typeof raw === "boolean" ? raw : raw === undefined || raw === null ? "" : String(raw);
      }
    }
    return values;
  }

  function setValue(key, value) {
    if (state.values[key] === value) return;
    state.values[key] = value;
    emit("values", { key, value });
    scheduleSave();
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    state.settingsNote = "Saving…";
    emit("settings", state.settingsNote);
    saveTimer = setTimeout(() => {
      saveSettings().catch((error) => {
        state.settingsNote = `Not saved: ${error.message}`;
        emit("settings", state.settingsNote);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  function settingsPayload() {
    const payload = {};
    for (const wf of WORKFLOWS) Object.assign(payload, optionsFor(wf.key));
    return payload;
  }

  async function saveSettings() {
    clearTimeout(saveTimer);
    const payload = await api("/api/settings", { method: "POST", body: JSON.stringify(settingsPayload()) });
    state.config = payload.config;
    state.settingsNote = `Saved ${fmtTime(new Date())}`;
    emit("settings", state.settingsNote);
    return payload.config;
  }

  async function resetSettings() {
    const payload = await api("/api/settings/reset", { method: "POST" });
    state.config = payload.config;
    state.values = valuesFromConfig(payload.config);
    state.settingsNote = "Reset to .env defaults";
    emit("values", { key: null });
    emit("settings", state.settingsNote);
  }

  // Options in the exact shape the classic panel sent, so server validation
  // and CLI argument building stay unchanged.
  function optionsFor(wfKey) {
    const wf = workflow(wfKey);
    const options = {};
    for (const key of wf.optionKeys) {
      const value = state.values[key];
      options[key] = typeof value === "boolean" ? value : String(value ?? "").trim();
    }
    if (wfKey === "screening") options.screeningKeepOpen = false;
    if (wfKey === "eic") options.eicAssessmentKeepOpen = false;
    return options;
  }

  // --- Jobs -------------------------------------------------------------------

  function jobRunning(job = state.job) {
    return Boolean(job && ["running", "stopping"].includes(job.status));
  }

  function setJob(job) {
    state.job = job || null;
    emit("job", state.job);
    closeStream();
    if (jobRunning(job)) openStream(job.id);
  }

  function closeStream() {
    state.stream?.close();
    state.stream = null;
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function openStream(jobId) {
    const stream = new EventSource(`/api/jobs/${jobId}/stream`);
    state.stream = stream;
    stream.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "snapshot" && payload.job) {
        state.job = payload.job;
        emit("job", state.job);
      } else if (payload.type === "output" && state.job) {
        state.job.output = (state.job.output || "") + payload.chunk;
        state.job.offset = payload.offset;
        state.job.progress = payload.progress;
        emit("job-output", { chunk: payload.chunk, job: state.job });
      } else if (payload.type === "status" && payload.job) {
        state.job = payload.job;
        closeStream();
        emit("job", state.job);
        refreshState().catch(reportError);
        refreshJobs().catch(() => undefined);
        refreshRuns().catch(() => undefined);
      }
    });
    stream.addEventListener("error", () => {
      closeStream();
      state.pollTimer = setInterval(pollJob, 2000);
    });
  }

  async function pollJob() {
    if (!state.job?.id) return;
    try {
      const since = state.job.offset || 0;
      const payload = await api(`/api/jobs/${state.job.id}?since=${since}`);
      if (payload.job) {
        const chunk = payload.job.output || "";
        state.job = { ...payload.job, output: (state.job.output || "") + chunk };
        if (chunk) emit("job-output", { chunk, job: state.job });
        emit("job", state.job);
      }
      if (!jobRunning(payload.job)) {
        closeStream();
        await refreshState();
        refreshJobs().catch(() => undefined);
        refreshRuns().catch(() => undefined);
      }
    } catch (error) {
      reportError(error);
    }
  }

  async function stopJob() {
    if (!state.job?.id) return;
    const payload = await api(`/api/jobs/${state.job.id}/stop`, { method: "POST" });
    setJob(payload.job);
  }

  async function startJobRequest(path, body) {
    if (jobRunning()) throw new Error("Another job is still running. Stop it or wait for it to finish.");
    const payload = await api(path, { method: "POST", body: JSON.stringify(body) });
    setJob(payload.job);
    return payload.job;
  }

  function confirmDangerous(message) {
    return window.confirm(`${message}\n\nThis cannot be undone in ScholarOne.`);
  }

  // --- Runners --------------------------------------------------------------

  async function runReject(mode) {
    const options = optionsFor("reject");
    if (mode === "dry") {
      delete options.maxRejected;
      return startJobRequest("/api/run/dryrun", options);
    }
    if (!confirmDangerous("Scan Complete Checklist and reject matching manuscripts immediately?")) return null;
    return startJobRequest("/api/run/live", options);
  }

  async function rejectFromReport(reportPath) {
    if (!reportPath) throw new Error("Select a report first.");
    const { maxChecked, queueStartPage, ...options } = optionsFor("reject");
    void maxChecked;
    void queueStartPage;
    if (!confirmDangerous(`Reject the candidates from this report?\n\n${reportPath}`)) return null;
    return startJobRequest("/api/run/send-from-report", { report: reportPath, ...options });
  }

  async function runAssessment(stage, mode) {
    const wfKey = stage === "eic" ? "eic" : "screening";
    const options = optionsFor(wfKey);
    const base = stage === "eic" ? "/api/run/eic-assessment" : "/api/run/screening";
    if (mode === "dry") return startJobRequest(`${base}/collect`, options);

    const scanAll = stage === "eic" ? options.eicAssessmentScanAll : options.screeningScanAll;
    const limit = stage === "eic" ? options.eicAssessmentMaxChecked : options.screeningMaxChecked;
    const queue = stage === "eic" ? "Awaiting EIC Assignment" : "Complete Checklist";
    const scope = scanAll ? `the entire ${queue} queue` : `at most ${limit} manuscripts`;
    const note = stage === "eic"
      ? "Every paper is first assigned to the configured EIC and AE. APPROVE stops at Assign Reviewers. REJECT submits “Reject - Fatally Flawed” and sends the configured email."
      : options.screeningApproveWithoutAssign
        ? "Rejection emails will be sent. Approved papers stay in Awaiting EIC Assignment for manual editor assignment."
        : "Rejection emails will be sent. Approved papers are assigned to the configured editor as EIC and AE.";
    if (!confirmDangerous(`Run LIVE over ${scope}?\n\n${note}`)) return null;
    const flag = stage === "eic" ? { eicAssessmentLive: true } : { screeningLive: true };
    return startJobRequest(`${base}/live`, { ...options, ...flag });
  }

  async function executeRun(stage, filename, run) {
    const pending = pendingRows(run);
    if (pending.length === 0) throw new Error("This run has no decisions left to execute.");
    const approve = pending.filter((row) => row.decision === "APPROVE").length;
    const reject = pending.filter((row) => row.decision === "REJECT").length;
    const wfKey = stage === "eic" ? "eic" : "screening";
    const options = optionsFor(wfKey);
    const note = stage === "eic"
      ? "Every paper is first assigned to the configured EIC and AE. APPROVE stops at Assign Reviewers. REJECT sends the configured decision email."
      : options.screeningApproveWithoutAssign
        ? "Rejection emails will be sent. Approved papers stay in Awaiting EIC Assignment."
        : "Rejection emails will be sent. Approved papers are assigned to the configured editor.";
    if (!confirmDangerous(`Execute ${pending.length} decisions from this run?\n\nAPPROVE: ${approve}\nREJECT: ${reject}\n\n${note}`)) return null;
    const base = stage === "eic" ? "/api/run/eic-assessment" : "/api/run/screening";
    const flag = stage === "eic" ? { eicAssessmentLive: true } : {};
    return startJobRequest(`${base}/execute`, { run: filename, ...options, ...flag });
  }

  async function runReviewers() {
    const options = optionsFor("reviewers");
    if (!confirmDangerous(`Invite up to ${options.reviewersPerPaper} reviewers for up to ${options.reviewerMaxManuscripts} papers?\n\nInvitation emails are sent for real.`)) return null;
    return startJobRequest("/api/run/reviewers/invite", options);
  }

  // --- Data loading -----------------------------------------------------------

  async function refreshState() {
    const payload = await api("/api/state");
    if (!state.config) {
      state.config = payload.config;
      state.values = valuesFromConfig(payload.config);
      state.settingsNote = payload.config.settingsSaved ? "Saved settings loaded" : "Defaults from .env";
      emit("values", { key: null });
      emit("settings", state.settingsNote);
    }
    state.reports = payload.reports || [];
    if (payload.activeJob && (!state.job || state.job.id !== payload.activeJob.id || !state.stream)) {
      setJob(payload.activeJob);
    }
    emit("state", state);
  }

  async function refreshJobs() {
    const { jobs } = await api("/api/jobs");
    state.jobs = jobs || [];
    emit("jobs", state.jobs);
  }

  async function refreshRuns() {
    const [initial, eic] = await Promise.all([
      api("/api/screening/runs").then((p) => p.runs || []).catch(() => []),
      api("/api/eic-assessment/runs").then((p) => p.runs || []).catch(() => []),
    ]);
    state.runs = { initial, eic };
    emit("runs", state.runs);
  }

  async function loadRun(stage, filename, { force = false } = {}) {
    const cacheKey = `${stage}:${filename}`;
    if (!force && state.runDetails.has(cacheKey)) return state.runDetails.get(cacheKey);
    const base = stage === "eic" ? "/api/eic-assessment/runs" : "/api/screening/runs";
    const { run } = await api(`${base}/${encodeURIComponent(filename)}`);
    state.runDetails.set(cacheKey, run);
    return run;
  }

  function pendingRows(run) {
    if (!run) return [];
    return run.manuscripts.filter((row) => row.decision && !row.assessmentError && !row.actionCompleted);
  }

  async function refreshQueues({ force = false } = {}) {
    if (state.queuesLoading) return;
    state.queuesLoading = true;
    emit("queues", state.queues);
    try {
      state.queues = await api(`/api/scholarone/status${force ? "?refresh=1" : ""}`);
    } catch (error) {
      const previous = state.queues;
      state.queues = {
        state: "unavailable",
        message: error.message,
        stale: Boolean(previous?.queues?.length),
        fetchedAt: previous?.fetchedAt || null,
        source: previous?.source || null,
        queues: previous?.queues || [],
      };
    } finally {
      state.queuesLoading = false;
      emit("queues", state.queues);
    }
  }

  function queuesStale() {
    const fetchedAt = state.queues?.fetchedAt;
    if (!fetchedAt) return true;
    return Date.now() - new Date(fetchedAt).getTime() >= QUEUE_STALE_MS;
  }

  function queueCount(label) {
    const item = state.queues?.queues?.find((queue) => queue.label === label);
    return item ? item.count : null;
  }

  async function refreshDoctor() {
    try {
      const { checks } = await api("/api/doctor");
      state.doctorProblems = checks.filter((check) => check.status !== "ok");
    } catch {
      state.doctorProblems = [];
    }
    emit("doctor", state.doctorProblems);
  }

  // --- CLI run monitor --------------------------------------------------------

  let lastLiveStatus = null;
  async function pollMonitor() {
    try {
      const payload = await api("/api/cli-run?tail=120");
      state.cliRun = payload.run || null;
      state.cliEvents = payload.events || [];
      state.cliOffline = false;
    } catch {
      state.cliOffline = true;
    }
    const liveStatus = state.cliRun?.effectiveStatus || null;
    if (liveStatus !== lastLiveStatus) {
      lastLiveStatus = liveStatus;
      refreshCliHistory().catch(() => undefined);
    }
    emit("monitor", state);
  }

  async function refreshCliHistory() {
    const { runs } = await api("/api/cli-run/history");
    state.cliHistory = runs || [];
    emit("monitor-history", state.cliHistory);
  }

  async function loadArchivedRun(filename) {
    return api(`/api/cli-run/history/${encodeURIComponent(filename)}?tail=2000`);
  }

  function startMonitor() {
    pollMonitor();
    setInterval(pollMonitor, MONITOR_POLL_MS);
  }

  // --- Formatting -------------------------------------------------------------

  function fmtDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function fmtTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--:--:--";
    return date.toLocaleTimeString(undefined, { hour12: false });
  }

  function secondsSince(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  }

  function relativeTime(value) {
    const seconds = secondsSince(value);
    if (seconds === null) return "—";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return fmtDate(value);
  }

  function reportStatusLabel(status) {
    if (!status) return "Unknown";
    return REPORT_STATUS_LABELS[status] || status.replaceAll("_", " ");
  }

  function jobLabel(type) {
    return JOB_LABELS[type] || type || "job";
  }

  function jobOutcome(job) {
    const progress = job.progress || {};
    const parts = [job.status === "finished" && job.exitCode ? `exit ${job.exitCode}` : job.status];
    if (progress.checked) parts.push(`checked ${progress.checked}`);
    if (progress.sent) parts.push(`sent ${progress.sent}`);
    if (progress.decisions?.APPROVE || progress.decisions?.REJECT) {
      parts.push(`APPROVE ${progress.decisions.APPROVE || 0} / REJECT ${progress.decisions.REJECT || 0}`);
    }
    if (progress.errors) parts.push(`errors ${progress.errors}`);
    return parts.join(" · ");
  }

  function progressText(progress) {
    if (!progress) return "";
    const parts = [];
    if (progress.checked) parts.push(`checked ${progress.checked}`);
    if (progress.currentManuscriptId) parts.push(progress.currentManuscriptId);
    const approve = progress.decisions?.APPROVE || 0;
    const reject = progress.decisions?.REJECT || 0;
    if (approve || reject) parts.push(`APPROVE ${approve} / REJECT ${reject}`);
    if (progress.sent) parts.push(`sent ${progress.sent}`);
    if (progress.liveActions) parts.push(`live actions ${progress.liveActions}${progress.liveActionLimit ? `/${progress.liveActionLimit}` : ""}`);
    if (progress.cacheHits) parts.push(`cache ${progress.cacheHits}`);
    if (progress.skipped) parts.push(`skipped ${progress.skipped}`);
    if (progress.errors) parts.push(`errors ${progress.errors}`);
    if (progress.tokenSummary) parts.push(progress.tokenSummary);
    return parts.join(" · ");
  }

  function eventTone(type) {
    if (!type) return "default";
    if (/rejected_and_sent|run_finished|succeeded|invite_confirmed|^sent$/i.test(type)) return "ok";
    if (/fail|error|not_found|mismatch|loop_detected|limit_reached/i.test(type)) return "bad";
    if (/login|stopped|skip|duplicate|not_actionable|unavailable/i.test(type)) return "warn";
    return "default";
  }

  function eventDetails(event) {
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

  function runSummaryText(run) {
    const counts = run.summary || {};
    return [
      `${run.manuscriptCount ?? run.manuscripts?.length ?? 0} papers`,
      counts.approved !== undefined ? `APPROVE ${counts.approved}` : null,
      counts.rejected !== undefined ? `REJECT ${counts.rejected}` : null,
      counts.assessmentErrors ? `errors ${counts.assessmentErrors}` : null,
      run.live ? "live" : "dry run",
    ].filter(Boolean).join(" · ");
  }

  // --- DOM helpers ------------------------------------------------------------

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (name === "class") node.className = value;
      else if (name === "dataset") Object.assign(node.dataset, value);
      else if (name.startsWith("on") && typeof value === "function") node.addEventListener(name.slice(2), value);
      else if (name in node && typeof value !== "string") node[name] = value;
      else node.setAttribute(name, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function logRow(event) {
    const text = el("span", { class: "log-text" });
    if (event.manuscriptId) text.append(el("b", { class: "log-id" }, event.manuscriptId), " ");
    text.append(eventDetails(event));
    return el("div", { class: "log-row", dataset: { tone: eventTone(event.type) } },
      el("span", { class: "log-time" }, fmtTime(event.at)),
      el("span", { class: "log-type" }, event.type || ""),
      text);
  }

  // Builds one form field bound to the shared values store.
  function fieldControl(field) {
    const value = state.values[field.key];
    let control;
    if (field.type === "scope") {
      control = el("select", { onchange: (e) => setValue(field.key, e.target.value === "all") },
        el("option", { value: "all", selected: value === true }, "Entire queue"),
        el("option", { value: "limited", selected: value !== true }, "Use safety limit"));
    } else if (field.type === "select") {
      control = el("select", { onchange: (e) => setValue(field.key, e.target.value) },
        ...field.choices.map((choice) => el("option", { value: choice, selected: String(value) === choice },
          field.labels?.[choice] || choice.charAt(0).toUpperCase() + choice.slice(1))));
    } else {
      control = el("input", {
        type: field.type, value: value ?? "", placeholder: field.placeholder || "",
        min: field.min, max: field.max, required: field.required || undefined,
        oninput: (e) => setValue(field.key, e.target.value),
      });
    }
    control.dataset.key = field.key;
    return el("label", { class: `field${field.wide ? " wide" : ""}` }, field.label, control);
  }

  function checkControl(check) {
    return el("label", { class: "check" },
      el("input", { type: "checkbox", checked: Boolean(state.values[check.key]), dataset: { key: check.key }, onchange: (e) => setValue(check.key, e.target.checked) }),
      check.label);
  }

  function textControl(text) {
    return el("label", { class: "field" }, text.label,
      el("textarea", { rows: text.rows, spellcheck: true, dataset: { key: text.key }, oninput: (e) => setValue(text.key, e.target.value) }, state.values[text.key] ?? ""));
  }

  // Monitor panel: beacon, count tiles and the event log for the live CLI run
  // or an archived log ({ run, events, totalEvents }). Shared by Desk and Ledger.
  function monitorPanel({ archive = null } = {}) {
    const run = archive ? archive.run : state.cliRun;
    const events = archive ? archive.events : state.cliEvents;
    let dotState = "idle", status = "Idle", note = "No run yet. Start one from a workflow or the CLI.";
    if (state.cliOffline && !archive) {
      dotState = "offline"; status = "Offline"; note = "UI server unreachable, retrying.";
    } else if (run) {
      const effective = archive ? run.status : run.effectiveStatus;
      const quiet = secondsSince(run.updatedAt);
      if (effective === "running") {
        const isQuiet = quiet !== null && quiet > 45;
        dotState = isQuiet ? "quiet" : "running"; status = "Running";
        note = isQuiet ? `Process is alive, but the log is quiet for ${quiet}s. It may wait for login or a slow page.` : "Process is alive and reporting.";
      } else if (effective === "finished") {
        dotState = "finished"; status = "Finished"; note = `Run completed ${relativeTime(run.finishedAt || run.updatedAt)}.`;
      } else if (effective === "failed") {
        dotState = "bad"; status = "Failed"; note = `Run failed ${relativeTime(run.finishedAt || run.updatedAt)}. Check the event log.`;
      } else if (effective === "dead") {
        dotState = "bad"; status = "Interrupted"; note = "The run says it is active, but the process is gone (killed or crashed).";
      } else if (effective === "interrupted") {
        dotState = "bad"; status = "Interrupted"; note = "The log ends without a final event.";
      } else {
        status = String(effective || "Unknown");
      }
    }
    const reviewers = run?.mode === "reviewers";
    const tile = (label, value, small = false) => el("div", { class: "tile" }, el("span", {}, label), el("b", { class: small ? "small" : "" }, value === null || value === undefined ? "—" : String(value)));
    const fact = (label, value) => el("div", {}, el("dt", {}, label), el("dd", {}, value === null || value === undefined || value === "" ? "—" : String(value)));
    const log = el("div", { class: "log" }, events.length ? events.map(logRow) : el("p", { class: "log-empty" }, run ? "No events yet." : "No run data yet."));
    const panel = el("div", { class: "monitor-panel-body" },
      el("div", { class: "beacon" },
        el("div", { class: "beacon-main" }, el("span", { class: "dot", dataset: { state: dotState } }),
          el("div", {}, el("div", { class: "beacon-status" }, status), el("div", { class: "beacon-note" }, note))),
        el("dl", { class: "facts" },
          fact("Mode", run?.mode), fact("PID", run?.pid),
          fact("Started", run ? relativeTime(run.startedAt) : null),
          fact(archive ? "Finished" : "Heartbeat", run ? relativeTime(archive ? run.finishedAt : run.updatedAt) : null))),
      el("div", { class: "tiles" },
        tile(reviewers ? "Papers" : "Checked", run ? (reviewers ? (run.papersRequested ? `${run.papersDone ?? 0} / ${run.papersRequested}` : run.papersDone) : run.checked) : null),
        tile(reviewers ? "Invited" : "Rejected", run ? (reviewers ? run.invited : run.rejected) : null),
        tile("Result", run?.resultStatus ? run.resultStatus.replaceAll("_", " ") : null, true),
        tile("Run ID", run?.runId, true)),
      el("div", { class: "card-title", style: "margin-top: 14px" }, el("h3", {}, "Event log"),
        el("span", { class: "sub" }, run?.logFile ? `tail of ${run.logFile}` : archive ? `${archive.events.length} of ${archive.totalEvents} events` : "")),
      log);
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    return panel;
  }

  // Options for a run picker: live first, then archived logs.
  function monitorPickerOptions(selected) {
    return [
      el("option", { value: "live", selected: selected === "live" }, "Live: follow current run"),
      ...state.cliHistory.filter((run) => run.status !== "running").map((run) => el("option", { value: run.filename, selected: selected === run.filename },
        [fmtDate(run.startedAt), run.mode, run.status === "finished" && run.resultStatus ? run.resultStatus.replaceAll("_", " ") : run.status].filter(Boolean).join(" · "))),
    ];
  }

  function validateForm(container) {
    const invalid = Array.from(container.querySelectorAll("input, select, textarea")).find((input) => !input.checkValidity());
    if (!invalid) return true;
    const details = invalid.closest("details");
    if (details) details.open = true;
    invalid.focus();
    invalid.reportValidity();
    return false;
  }

  function reportError(error) {
    console.error(error);
    emit("error", error);
  }

  async function init({ monitor = true, queues = true, doctor = true } = {}) {
    await refreshState();
    refreshJobs().catch(reportError);
    refreshRuns().catch(reportError);
    if (queues) refreshQueues().catch(reportError);
    if (doctor) refreshDoctor();
    if (monitor) startMonitor();
  }

  return {
    state, on, emit, api, init,
    WORKFLOWS, workflow, jobLabel, jobOutcome, progressText, reportStatusLabel, runSummaryText,
    setValue, saveSettings, resetSettings, optionsFor,
    jobRunning, stopJob, runReject, rejectFromReport, runAssessment, executeRun, runReviewers,
    refreshState, refreshJobs, refreshRuns, loadRun, pendingRows, refreshQueues, queuesStale, queueCount, refreshDoctor,
    refreshCliHistory, loadArchivedRun, pollMonitor,
    fmtDate, fmtTime, relativeTime, secondsSince, eventTone, eventDetails,
    el, logRow, fieldControl, checkControl, textControl, validateForm, reportError, monitorPanel, monitorPickerOptions,
  };
})();
