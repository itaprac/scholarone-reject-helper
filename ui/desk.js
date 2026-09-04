// Desk layout: ScholarOne queues are the navigation, a job dock sits at the
// bottom of every view. All data comes from window.S1 (shared.js).

(() => {
  const S = window.S1;
  const { el } = S;

  const VIEWS = ["reject", "screening", "eic", "reviewers", "monitor", "queues"];
  const GROUPS = [
    { label: "Intake", queues: ["Complete Checklist"], workflows: ["reject", "screening"] },
    { label: "Editor assignment", queues: ["Awaiting EIC Assignment"], workflows: ["eic"] },
    { label: "Reviewers", queues: ["Assign Reviewers", "Select Reviewers", "Invite Reviewers"], workflows: ["reviewers"] },
    { label: "Follow-up (read only)", queues: ["Awaiting Reviewer Scores", "Overdue Reviewer Scores"], workflows: [] },
  ];
  const JOB_TYPES = {
    reject: ["dryrun", "live-reject", "reject-from-report"],
    screening: ["initial-assessment-dryrun", "initial-assessment-live", "initial-assessment-from-run"],
    eic: ["eic-assessment-dryrun", "eic-assessment-live", "eic-assessment-from-run"],
    reviewers: ["reviewers-invite"],
  };

  const ui = {
    view: viewFromHash(),
    selectedReport: "",
    selectedRun: { initial: "", eic: "" },
    filter: { initial: "", eic: "" },
    runDetail: { initial: null, eic: null },
    monitorPick: "live",
    archive: null,
    renderPending: false,
  };

  const $ = (id) => document.getElementById(id);

  function viewFromHash() {
    const hash = location.hash.replace("#", "");
    return VIEWS.includes(hash) ? hash : "screening";
  }

  // --- Rail -----------------------------------------------------------------

  function lastRunLabel(wfKey) {
    const running = S.state.job && S.jobRunning() && JOB_TYPES[wfKey].includes(S.state.job.type);
    if (running) return { text: "running", live: true };
    if (wfKey === "reviewers" && S.state.cliRun?.mode === "reviewers" && S.state.cliRun.effectiveStatus === "running") {
      return { text: "running (CLI)", live: true };
    }
    const job = S.state.jobs.find((item) => JOB_TYPES[wfKey].includes(item.type));
    if (!job) return { text: "", live: false };
    return { text: `${job.status === "failed" ? "failed " : ""}${S.relativeTime(job.startedAt)}`, live: false };
  }

  function renderRail() {
    const rail = $("rail");
    rail.replaceChildren();
    for (const group of GROUPS) {
      const box = el("div", { class: "rail-group" }, el("div", { class: "rail-label" }, group.label));
      for (const label of group.queues) {
        const count = S.queueCount(label);
        box.append(el("div", { class: "queue-line", dataset: { zero: String(count === 0) } },
          el("span", {}, label), el("b", {}, count === null ? "—" : String(count))));
      }
      for (const key of group.workflows) {
        const wf = S.workflow(key);
        const last = lastRunLabel(key);
        box.append(el("button", {
          class: "nav-item", type: "button", "aria-current": ui.view === key ? "page" : "false",
          onclick: () => setView(key),
        }, el("span", {}, wf.name), el("span", { class: "last", dataset: { live: String(last.live) } }, last.text)));
      }
      rail.append(box);
    }
    rail.append(el("hr"));
    for (const [key, label] of [["monitor", "Monitor"], ["queues", "All queues"]]) {
      rail.append(el("button", {
        class: "nav-item plain", type: "button", "aria-current": ui.view === key ? "page" : "false",
        onclick: () => setView(key),
      }, el("span", {}, label)));
    }
  }

  function setView(view) {
    ui.view = view;
    if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
    renderRail();
    renderMain({ force: true });
    if (view === "queues" && S.queuesStale()) S.refreshQueues({ force: true });
    if (view === "monitor") S.refreshCliHistory().catch(() => undefined);
  }

  // --- Main -----------------------------------------------------------------

  // Re-rendering while the editor types in a field would drop focus, so a
  // render requested during typing waits for focusout.
  function renderMain({ force = false } = {}) {
    const main = $("main");
    const active = document.activeElement;
    if (!force && active && main.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
      ui.renderPending = true;
      return;
    }
    ui.renderPending = false;
    main.replaceChildren();
    if (S.state.doctorProblems.length) {
      main.append(el("div", { class: "doctor-line" }, S.state.doctorProblems.map((check) => `${check.name}: ${check.detail}${check.hint ? ` (${check.hint})` : ""}`).join(" · ")));
    }
    if (ui.view === "monitor") main.append(monitorView());
    else if (ui.view === "queues") main.append(queuesView());
    else main.append(workflowView(S.workflow(ui.view)));
  }

  function queueChip(wf) {
    const count = S.queueCount(wf.queue);
    return el("div", { class: "queue-chip" }, wf.queue, el("b", {}, count === null ? "—" : String(count)),
      el("button", { class: "btn link small", type: "button", title: "Read ScholarOne again", onclick: () => S.refreshQueues({ force: true }) }, "↻"));
  }

  function workflowView(wf) {
    const running = S.jobRunning();
    const form = el("div", { class: "card" },
      el("div", { class: "card-title" }, el("h3", {}, "Run settings"), el("span", { class: "sub settings-note", id: "settingsNote" }, S.state.settingsNote)),
      el("div", { class: "form-grid" }, wf.fields.map(S.fieldControl)),
      wf.checks.map(S.checkControl),
      el("details", { class: "more" }, el("summary", {}, "Advanced"), el("div", { class: "form-grid" }, wf.advanced.map(S.fieldControl))),
      wf.texts.length ? el("details", { class: "more" }, el("summary", {}, wf.texts.map((t) => t.label).join(" and ")), el("div", { class: "texts" }, wf.texts.map(S.textControl))) : null,
      el("div", { class: "actions" },
        wf.dryLabel ? el("button", { class: "btn primary", type: "button", disabled: running, onclick: () => guard(form, () => runWorkflow(wf, "dry")) }, wf.dryLabel) : null,
        el("button", { class: "btn danger", type: "button", disabled: running, onclick: () => guard(form, () => runWorkflow(wf, "live")) }, wf.liveLabel),
        el("button", { class: "btn ghost small", type: "button", title: "Delete ui-settings.json and reload .env defaults", onclick: () => {
          if (window.confirm("Reset all saved UI settings to .env defaults?")) S.resetSettings().then(() => renderMain({ force: true })).catch(S.reportError);
        } }, "Reset settings"),
        el("span", { class: "note" }, wf.liveNote)));
    syncScope(form);
    form.addEventListener("change", () => syncScope(form));

    const results = wf.key === "reject" ? reportsCard() : wf.stage ? assessmentCard(wf) : reviewersCard();
    return el("section", {},
      el("div", { class: "head" }, el("div", {}, el("h2", {}, wf.name), el("p", {}, wf.summary)), queueChip(wf)),
      form, results);
  }

  // Safety limit only matters when the scope is "limited".
  function syncScope(form) {
    for (const [scopeKey, limitKey] of [["screeningScanAll", "screeningMaxChecked"], ["eicAssessmentScanAll", "eicAssessmentMaxChecked"]]) {
      const limit = form.querySelector(`[data-key="${limitKey}"]`);
      if (limit) limit.disabled = S.state.values[scopeKey] === true;
    }
  }

  function guard(form, action) {
    if (!S.validateForm(form)) return;
    action().catch(S.reportError);
  }

  async function runWorkflow(wf, mode) {
    if (wf.key === "reject") return S.runReject(mode);
    if (wf.stage) return S.runAssessment(wf.stage, mode);
    return S.runReviewers();
  }

  function reportsCard() {
    const reports = S.state.reports;
    const selected = reports.find((report) => report.path === ui.selectedReport) || null;
    if (!selected) ui.selectedReport = "";
    const rows = reports.length ? reports.map((report) => el("tr", {
      class: "selectable", tabindex: 0, "aria-selected": String(report.path === ui.selectedReport),
      onclick: () => selectReport(report.path),
      onkeydown: (e) => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); selectReport(report.path); } },
    },
      el("td", {}, S.fmtDate(report.createdAt), el("span", { class: "title" }, report.filename)),
      el("td", {}, S.reportStatusLabel(report.status)),
      el("td", { class: "num" }, String(report.checked)),
      el("td", {}, el("span", { class: "pill" }, String(report.candidates || 0))),
      el("td", {}, [report.progressRejected ? `sent ${report.progressRejected}` : null, report.progressSkipped ? `skipped ${report.progressSkipped}` : null].filter(Boolean).join(", ") || "Not started")))
      : [el("tr", {}, el("td", { class: "empty", colspan: 5 }, "No reports yet. Run a dry run to create one."))];

    return el("div", { class: "card" },
      el("div", { class: "card-title" }, el("h3", {}, "Reports"), el("span", { class: "sub" }, "Select a dry-run report to reject its candidates")),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ...["Report", "Status", "Checked", "Candidates", "Progress"].map((h) => el("th", { scope: "col" }, h)))),
        el("tbody", {}, rows))),
      el("div", { class: "exec-bar", dataset: { quiet: String(!selected) } },
        el("div", {}, el("b", {}, selected ? `${selected.candidates || 0} candidates, ${selected.progressRejected || 0} already sent` : "No report selected"),
          el("span", {}, "Rejects only the candidates listed in the report. Manuscripts already sent are skipped.")),
        el("button", { class: "btn danger", type: "button", disabled: !selected || S.jobRunning(), onclick: () => S.rejectFromReport(ui.selectedReport).catch(S.reportError) }, "Reject selected report")));
  }

  function selectReport(path) {
    ui.selectedReport = ui.selectedReport === path ? "" : path;
    renderMain({ force: true });
  }

  function assessmentCard(wf) {
    const stage = wf.stage;
    const runs = S.state.runs[stage];
    if (runs.length && !runs.some((run) => run.filename === ui.selectedRun[stage])) {
      ui.selectedRun[stage] = runs[0].filename;
      ui.runDetail[stage] = null;
    }
    const selected = runs.find((run) => run.filename === ui.selectedRun[stage]) || null;
    const card = el("div", { class: "card" });
    card.append(el("div", { class: "card-title" }, el("h3", {}, "Saved runs"),
      el("span", { class: "sub" }, selected ? `${selected.filename} · ${S.runSummaryText(selected)}` : "No saved runs yet")));

    if (!selected) {
      card.append(el("p", { class: "settings-note" }, "Run a dry run to create the first batch. Results appear here without opening files."));
      return card;
    }

    const detail = ui.runDetail[stage];
    if (!detail || detail.runId !== selected.runId) {
      S.loadRun(stage, selected.filename).then((run) => {
        ui.runDetail[stage] = run;
        renderMain({ force: true });
      }).catch(S.reportError);
    }

    card.append(el("div", { class: "filters" },
      el("select", { "aria-label": "Run", onchange: (e) => { ui.selectedRun[stage] = e.target.value; ui.runDetail[stage] = null; renderMain({ force: true }); } },
        runs.map((run) => el("option", { value: run.filename, selected: run.filename === selected.filename }, `${S.fmtDate(run.createdAt)} · ${run.manuscriptCount} papers${run.live ? " · live" : ""}`))),
      el("select", { "aria-label": "Decision filter", onchange: (e) => { ui.filter[stage] = e.target.value; renderMain({ force: true }); } },
        [["", "All decisions"], ["APPROVE", "APPROVE"], ["REJECT", "REJECT"], ["ERROR", "Errors"]].map(([value, label]) => el("option", { value, selected: ui.filter[stage] === value }, label))),
      el("span", { class: "spacer" }),
      el("button", { class: "btn small", type: "button", onclick: () => { S.state.runDetails.clear(); ui.runDetail[stage] = null; S.refreshRuns().catch(S.reportError); } }, "Refresh")));

    const run = detail && detail.runId === selected.runId ? detail : null;
    card.append(assessmentTable(run, ui.filter[stage]));

    const pending = S.pendingRows(run);
    card.append(el("div", { class: "exec-bar", dataset: { quiet: String(pending.length === 0) } },
      el("div", {}, el("b", {}, run ? (pending.length ? `${pending.length} decisions ready to execute` : "Nothing left to execute in this run") : "Loading run…"),
        el("span", {}, "Applies the decisions above without asking the model again. Manuscripts already handled are skipped.")),
      el("button", { class: "btn danger", type: "button", disabled: !run || pending.length === 0 || S.jobRunning(),
        onclick: () => S.executeRun(stage, selected.filename, run).catch(S.reportError) }, "Execute these decisions")));
    return card;
  }

  function assessmentTable(run, filter) {
    const head = el("thead", {}, el("tr", {}, ...["Manuscript", "Decision", "Reason", "Tokens", "Action"].map((h) => el("th", { scope: "col" }, h))));
    if (!run) return el("div", { class: "table-wrap" }, el("table", {}, head, el("tbody", {}, el("tr", {}, el("td", { class: "empty", colspan: 5 }, "Loading…")))));
    const rows = run.manuscripts.filter((row) => {
      if (!filter) return true;
      if (filter === "ERROR") return Boolean(row.assessmentError || row.actionError);
      return row.decision === filter;
    });
    const body = rows.length ? rows.map(assessmentRow) : [el("tr", {}, el("td", { class: "empty", colspan: 5 }, "No results for this filter."))];
    return el("div", { class: "table-wrap" }, el("table", {}, head, el("tbody", {}, body)));
  }

  function assessmentRow(row) {
    const decision = row.decision || (row.assessmentError ? "ERROR" : "—");
    return el("tr", {},
      el("td", {}, el("span", { class: "id" }, row.manuscriptId || "—"), el("span", { class: "title" }, row.title),
        el("details", {}, el("summary", {}, "abstract"), el("p", { class: "abstract" }, row.abstract || "(none)"))),
      el("td", {}, el("span", { class: "decision", dataset: { d: decision }, title: row.cached ? "result from cache" : "" }, decision)),
      el("td", { class: "reason" }, row.assessmentError || row.reason || "—"),
      el("td", { class: "num" }, row.cached ? "cache" : String(row.totalTokens ?? "—")),
      el("td", {}, row.actionError ? `failed: ${row.actionError}` : row.actionCompleted ? `done: ${row.actionDecision}` : "—"));
  }

  function reviewersCard() {
    const run = S.state.cliRun;
    const isReviewers = run?.mode === "reviewers";
    const logs = S.state.cliHistory.filter((item) => item.mode === "reviewers" || /^select-reviewers-/.test(item.filename));
    const card = el("div", { class: "card" },
      el("div", { class: "card-title" }, el("h3", {}, "Reviewer runs"), el("span", { class: "sub" }, "Progress comes from logs/current-run.json, also for runs started from the CLI")));
    if (isReviewers) {
      card.append(el("div", { class: "tiles" },
        tile("Status", run.effectiveStatus),
        tile("Papers", Number.isFinite(run.papersDone) ? (run.papersRequested ? `${run.papersDone} / ${run.papersRequested}` : String(run.papersDone)) : "—"),
        tile("Invited", run.invited ?? "—"),
        tile("Last event", run.lastEvent?.type || "—", true)));
    }
    card.append(el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ...["Started", "Status", "Papers", "Invited", "Log"].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, logs.length ? logs.slice(0, 15).map((item) => el("tr", {},
        el("td", {}, S.fmtDate(item.startedAt)),
        el("td", {}, el("span", { class: "decision", dataset: { d: item.status === "failed" ? "REJECT" : item.status === "finished" ? "APPROVE" : "" } }, item.status)),
        el("td", { class: "num" }, item.papersDone ?? "—"),
        el("td", { class: "num" }, item.invited ?? "—"),
        el("td", {}, el("button", { class: "btn link small", type: "button", onclick: () => { ui.monitorPick = item.filename; setView("monitor"); } }, "open in Monitor"))))
        : [el("tr", {}, el("td", { class: "empty", colspan: 5 }, "No reviewer runs yet."))]))));
    return card;
  }

  function tile(label, value, small = false) {
    return el("div", { class: "tile" }, el("span", {}, label), el("b", { class: small ? "small" : "" }, value === null || value === undefined ? "—" : String(value)));
  }

  // --- Monitor view -----------------------------------------------------------

  function monitorView() {
    const section = el("section", {},
      el("div", { class: "head" },
        el("div", {}, el("h2", {}, "Monitor"), el("p", {}, "Live status of the automation script, including runs started from the CLI. Pick a past run to read its full event log.")),
        el("label", { class: "field", style: "min-width: 320px" }, "Run",
          el("select", { id: "monitorPick", onchange: (e) => pickMonitorRun(e.target.value) }, S.monitorPickerOptions(ui.monitorPick)))),
      el("div", { id: "monitorBody" }));
    if (ui.monitorPick !== "live" && ui.archive?.run?.filename !== ui.monitorPick) pickMonitorRun(ui.monitorPick);
    renderMonitorBody(section.querySelector("#monitorBody"));
    return section;
  }

  function pickMonitorRun(value) {
    ui.monitorPick = value;
    if (value === "live") {
      ui.archive = null;
      renderMonitorBody();
      return;
    }
    S.loadArchivedRun(value).then((payload) => {
      ui.archive = payload;
      renderMonitorBody();
    }).catch(S.reportError);
  }

  function renderMonitorBody(target = $("monitorBody")) {
    if (!target) return;
    const archive = ui.monitorPick !== "live" ? ui.archive : null;
    target.replaceChildren(S.monitorPanel({ archive }));
  }

  // --- Queues view ------------------------------------------------------------

  function queuesView() {
    const status = S.state.queues;
    const queues = status?.queues || [];
    const label = S.state.queuesLoading ? "Reading ScholarOne…" : !status ? "Not checked yet"
      : status.state === "ready" ? "Live status" : status.stale ? "Saved status" : status.state === "auth_required" ? "Sign-in required" : status.state === "busy" ? "Profile in use" : "Status unavailable";
    const usedBy = (queue) => {
      const wf = S.WORKFLOWS.find((item) => item.queue === queue.label);
      return wf ? wf.name : queue.workflow || "ScholarOne";
    };
    return el("section", {},
      el("div", { class: "head" }, el("div", {}, el("h2", {}, "All queues"), el("p", {}, "Counts read from the ScholarOne Admin Center. The rail shows the same numbers next to the workflow that uses them.")),
        el("button", { class: "btn", type: "button", disabled: S.state.queuesLoading, onclick: () => S.refreshQueues({ force: true }) }, "Refresh queues")),
      el("div", { class: "status-line" }, el("span", { class: "dot", dataset: { state: S.state.queuesLoading ? "running" : status?.state === "ready" ? "finished" : status?.stale ? "quiet" : status ? "bad" : "idle" } }),
        el("b", {}, label), el("span", {}, status?.fetchedAt ? `updated ${S.fmtDate(status.fetchedAt)}` : ""), el("span", {}, status && status.state !== "ready" ? status.message || "" : "")),
      el("div", { class: "table-wrap" }, el("table", { class: "queue-table" },
        el("thead", {}, el("tr", {}, ...["Queue", "Count", "Used by"].map((h) => el("th", { scope: "col" }, h)))),
        el("tbody", {}, queues.length ? queues.map((queue) => el("tr", { dataset: { zero: String(queue.count === 0) } },
          el("td", {}, queue.label), el("td", {}, el("b", {}, String(queue.count))), el("td", { class: "wf" }, usedBy(queue))))
          : [el("tr", {}, el("td", { class: "empty", colspan: 3 }, status?.message || "No queue counts available yet."))]))));
  }

  // --- Dock -------------------------------------------------------------------

  function renderDock() {
    const job = S.state.job;
    const running = S.jobRunning(job);
    $("dockDot").dataset.state = !job ? "idle" : running ? (job.status === "stopping" ? "stopping" : "running") : job.status === "failed" ? "failed" : "finished";
    $("dockName").textContent = job ? `${S.jobLabel(job.type)} · ${job.status}${job.exitCode !== null && job.exitCode !== undefined ? `, exit ${job.exitCode}` : ""}` : "No active job";
    $("dockProgress").textContent = job ? S.progressText(job.progress) : "Start a dry run from a workflow page. Output appears here.";
    $("stopBtn").disabled = !running;
    const output = $("dockOutput");
    output.textContent = job ? (job.output || "Job started…") : "No active job.";
    output.scrollTop = output.scrollHeight;
    const top = $("topStatus");
    if (!top.dataset.errorUntil || Date.now() > Number(top.dataset.errorUntil)) {
      top.dataset.tone = job && running ? "active" : job?.status === "failed" ? "error" : "neutral";
      top.querySelector(".msg").textContent = job ? (running ? `${S.jobLabel(job.type)} running` : `${S.jobLabel(job.type)} ${job.status}`) : "Ready";
    }
    syncDockHeight();
  }

  function appendOutput(chunk) {
    const output = $("dockOutput");
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    if (output.textContent === "No active job." || output.textContent === "Job started…") output.textContent = "";
    output.textContent += chunk;
    if (atBottom) output.scrollTop = output.scrollHeight;
    $("dockProgress").textContent = S.progressText(S.state.job?.progress);
  }

  function renderDockJobs() {
    $("dockJobs").replaceChildren(...(S.state.jobs.length ? S.state.jobs.slice(0, 12).map((job) => el("li", { dataset: { status: job.status } },
      el("span", { class: "when" }, S.fmtDate(job.startedAt)), el("span", {}, S.jobLabel(job.type)), el("span", { class: "out" }, S.jobOutcome(job))))
      : [el("li", {}, "No saved jobs yet.")]));
  }

  function setDockOpen(open) {
    $("dock").dataset.open = String(open);
    $("dockToggle").setAttribute("aria-expanded", String(open));
    $("dockToggle").textContent = open ? "▼ Job" : "▲ Job";
    syncDockHeight();
  }

  function syncDockHeight() {
    const height = $("dock").offsetHeight;
    document.documentElement.style.setProperty("--dock-h", `${height}px`);
    window.S1Switch?.setOffset(height + 10);
  }

  function showError(error) {
    const top = $("topStatus");
    top.dataset.tone = "error";
    top.dataset.errorUntil = String(Date.now() + 8000);
    top.querySelector(".msg").textContent = error.message || String(error);
    setTimeout(() => { delete top.dataset.errorUntil; renderDock(); }, 8000);
  }

  // --- Wiring -----------------------------------------------------------------

  S.on("state", () => { renderRail(); renderMain(); });
  S.on("jobs", () => { renderRail(); renderDockJobs(); });
  S.on("runs", () => { if (ui.view === "screening" || ui.view === "eic") renderMain(); });
  S.on("queues", () => { renderRail(); if (ui.view === "queues") renderMain(); else { const chip = document.querySelector(".queue-chip b"); if (chip) { const count = S.queueCount(S.workflow(ui.view)?.queue); chip.textContent = count === null ? "—" : String(count); } } });
  S.on("job", (job) => { renderDock(); renderRail(); if (job && S.jobRunning(job) && $("dock").dataset.open !== "true") setDockOpen(true); renderMain(); });
  S.on("job-output", ({ chunk }) => appendOutput(chunk));
  S.on("monitor", () => {
    if (ui.view === "monitor" && ui.monitorPick === "live") renderMonitorBody();
    if (ui.view === "reviewers") renderMain();
    const label = document.querySelector('.nav-item .last[data-live]');
    if (label) renderRail();
  });
  S.on("monitor-history", () => { if (ui.view === "monitor" || ui.view === "reviewers") renderMain(); });
  S.on("settings", (note) => { const target = $("settingsNote"); if (target) target.textContent = note; });
  S.on("values", ({ key }) => { if (key === null) renderMain({ force: true }); });
  S.on("doctor", () => renderMain());
  S.on("error", showError);

  $("dockToggle").addEventListener("click", () => setDockOpen($("dock").dataset.open !== "true"));
  $("stopBtn").addEventListener("click", () => S.stopJob().catch(showError));
  $("main").addEventListener("focusout", () => { if (ui.renderPending) setTimeout(() => { if (ui.renderPending) renderMain(); }, 50); });
  window.addEventListener("hashchange", () => setView(viewFromHash()));
  window.addEventListener("resize", syncDockHeight);

  renderRail();
  renderDock();
  S.init().then(() => setView(ui.view)).catch(showError);
})();
