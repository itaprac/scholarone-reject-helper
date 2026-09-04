// Ledger layout: every run is a row. Saved assessment batches, reject reports
// and reviewer logs share one chronological list with a dry run → review →
// executed path. New runs start from a drawer. Data comes from window.S1.

(() => {
  const S = window.S1;
  const { el } = S;

  const FOCUS_QUEUES = ["Complete Checklist", "Awaiting EIC Assignment", "Assign Reviewers", "Select Reviewers", "Invite Reviewers", "Awaiting Reviewer Scores", "Overdue Reviewer Scores"];
  const FILTERS = [["all", "All"], ["review", "Needs review"], ["screening", "Initial"], ["eic", "EIC"], ["reject", "Reject"], ["reviewers", "Reviewers"]];

  const ui = {
    filter: "all",
    expanded: null,
    details: new Map(), // rowId -> loaded detail (run, archive log)
    decisionFilter: {},
    drawerWf: null,
    // Expanded running job: "monitor" (beacon, tiles, events) or raw "log".
    jobView: localStorage.getItem("s1.ledger.jobView") || "monitor",
  };
  const $ = (id) => document.getElementById(id);

  // --- Counts strip -------------------------------------------------------------

  const QUEUE_GROUPS = [
    { label: "Intake", queues: ["Complete Checklist"] },
    { label: "Editor assignment", queues: ["Awaiting EIC Assignment"] },
    { label: "Reviewers", queues: ["Assign Reviewers", "Select Reviewers", "Invite Reviewers"] },
    { label: "Follow-up", queues: ["Awaiting Reviewer Scores", "Overdue Reviewer Scores"] },
  ];

  function queueLine(label, count, focus) {
    return el("div", { class: "queue-line", dataset: { zero: String(count === 0), focus: String(focus) } },
      el("span", {}, label), el("b", {}, count === null ? "—" : String(count)));
  }

  function renderCounts() {
    const status = S.state.queues;
    const known = new Set(FOCUS_QUEUES);
    const others = (status?.queues || []).filter((queue) => !known.has(queue.label));
    const groups = QUEUE_GROUPS.map((group) => el("div", { class: "rail-group" },
      el("div", { class: "rail-label" }, group.label),
      group.queues.map((label) => queueLine(label, S.queueCount(label), true))));
    const other = others.length ? el("details", { class: "more" }, el("summary", {}, `Other queues (${others.length})`),
      others.map((queue) => queueLine(queue.label, queue.count, false))) : null;
    const stamp = el("div", { class: "stamp" },
      el("span", {}, S.state.queuesLoading ? "Reading ScholarOne…" : status?.fetchedAt ? `ScholarOne read ${S.relativeTime(status.fetchedAt)}` : "Queue counts not read yet"),
      status && status.state !== "ready" && !S.state.queuesLoading ? el("span", {}, status.message || "saved status") : null,
      el("button", { class: "btn small", type: "button", disabled: S.state.queuesLoading, onclick: () => S.refreshQueues({ force: true }) }, "Refresh queues"));
    $("counts").replaceChildren(...groups, ...(other ? [other] : []), stamp);
  }

  function renderDoctor() {
    const box = $("doctor");
    const problems = S.state.doctorProblems;
    box.hidden = problems.length === 0;
    box.textContent = problems.map((check) => `${check.name}: ${check.detail}${check.hint ? ` (${check.hint})` : ""}`).join(" · ");
  }

  // --- New run menu + drawer --------------------------------------------------------

  function renderMenu() {
    $("menu").replaceChildren(...S.WORKFLOWS.map((wf) => {
      const count = S.queueCount(wf.queue);
      return el("button", { role: "menuitem", type: "button", onclick: () => { toggleMenu(false); openDrawer(wf.key); } },
        el("b", {}, wf.name), el("small", {}, wf.summary), el("span", { class: "q" }, wf.queue, " ", el("b", {}, count === null ? "—" : String(count))));
    }));
  }

  function toggleMenu(open) {
    const menu = $("menu");
    const next = open ?? menu.dataset.open !== "true";
    menu.dataset.open = String(next);
    $("newRunBtn").setAttribute("aria-expanded", String(next));
  }

  function openDrawer(wfKey) {
    const wf = S.workflow(wfKey);
    ui.drawerWf = wfKey;
    const count = S.queueCount(wf.queue);
    $("drawerTitle").textContent = wf.name;
    $("drawerSub").textContent = `${wf.queue}: ${count === null ? "unknown count" : `${count} manuscripts now`}. ${wf.summary}`;
    const body = $("drawerBody");
    body.replaceChildren(
      el("h4", {}, "Run"),
      el("div", { class: "form-grid" }, wf.fields.map(S.fieldControl)),
      ...wf.checks.map(S.checkControl),
      el("details", { class: "more" }, el("summary", {}, "Advanced"), el("div", { class: "form-grid" }, wf.advanced.map(S.fieldControl))),
      ...wf.texts.map((text) => el("details", { class: "more" }, el("summary", {}, text.label), S.textControl(text))),
      el("p", { class: "settings-note", id: "settingsNote", style: "margin-top: 14px" }, S.state.settingsNote));
    syncScope(body);
    body.addEventListener("change", () => syncScope(body));
    const running = S.jobRunning();
    $("drawerFoot").replaceChildren(
      el("div", { class: "row2" },
        wf.dryLabel ? el("button", { class: "btn primary", type: "button", disabled: running, onclick: () => start(wf, "dry") }, wf.dryLabel) : null,
        el("button", { class: "btn danger", type: "button", disabled: running, onclick: () => start(wf, "live") }, wf.liveLabel)),
      el("span", { class: "note" }, running ? "Another job is running. Wait for it to finish or stop it from its row." : `${wf.dryLabel ? "A dry run adds a row you can review and execute later. " : ""}${wf.liveNote}`));
    $("drawer").dataset.open = "true";
    $("drawer").setAttribute("aria-hidden", "false");
    $("scrim").dataset.open = "true";
  }

  function syncScope(form) {
    for (const [scopeKey, limitKey] of [["screeningScanAll", "screeningMaxChecked"], ["eicAssessmentScanAll", "eicAssessmentMaxChecked"]]) {
      const limit = form.querySelector(`[data-key="${limitKey}"]`);
      if (limit) limit.disabled = S.state.values[scopeKey] === true;
    }
  }

  function closeDrawer() {
    ui.drawerWf = null;
    $("drawer").dataset.open = "false";
    $("drawer").setAttribute("aria-hidden", "true");
    $("scrim").dataset.open = "false";
  }

  async function start(wf, mode) {
    if (!S.validateForm($("drawerBody"))) return;
    try {
      const job = wf.key === "reject" ? await S.runReject(mode) : wf.stage ? await S.runAssessment(wf.stage, mode) : await S.runReviewers();
      if (job) closeDrawer();
    } catch (error) {
      showError(error);
    }
  }

  // --- Ledger rows ------------------------------------------------------------------

  // Every source becomes a row: { id, when, kind, wfKey, label, mode, outcome, sub, path, action, live }
  function buildRows() {
    const rows = [];
    const job = S.state.job;
    const jobRunning = S.jobRunning(job);
    const cli = S.state.cliRun;

    if (jobRunning) {
      rows.push({
        id: `job:${job.id}`, when: job.startedAt, kind: "job", live: true, wfKey: wfKeyForJob(job.type),
        label: S.jobLabel(job.type).split(", ")[0], mode: S.jobLabel(job.type).split(", ")[1] || job.status,
        outcome: S.progressText(job.progress) || job.status, sub: "started from this panel", path: "live", job,
      });
    } else if (cli?.effectiveStatus === "running") {
      rows.push({
        id: `cli:${cli.runId}`, when: cli.startedAt, kind: "cli", live: true, wfKey: cli.mode === "reviewers" ? "reviewers" : "reject",
        label: cli.mode === "reviewers" ? "Reviewers" : cli.mode || "Run", mode: "running from CLI",
        outcome: cli.mode === "reviewers" ? `${cli.papersDone ?? 0} of ${cli.papersRequested ?? "?"} papers · ${cli.invited ?? 0} invited` : `${cli.checked ?? 0} checked · ${cli.rejected ?? 0} rejected`,
        sub: cli.lastEvent?.type ? `last event ${cli.lastEvent.type}` : "", path: "live", cli,
      });
    }

    for (const stage of ["initial", "eic"]) {
      for (const run of S.state.runs[stage]) {
        const detail = S.state.runDetails.get(`${stage}:${run.filename}`) || null;
        const pending = detail ? S.pendingRows(detail).length : null;
        const executed = detail ? detail.manuscripts.filter((row) => row.actionCompleted).length : null;
        const counts = run.summary || {};
        rows.push({
          id: `${stage}:${run.filename}`, when: run.createdAt, kind: "assessment", stage, run, detail,
          wfKey: stage === "eic" ? "eic" : "screening", label: stage === "eic" ? "EIC assessment" : "Initial assessment",
          mode: run.live ? "live" : "dry run",
          outcome: [`${run.manuscriptCount} papers`, counts.approved !== undefined ? `APPROVE ${counts.approved}` : null, counts.rejected !== undefined ? `REJECT ${counts.rejected}` : null, counts.assessmentErrors ? `${counts.assessmentErrors} errors` : null].filter(Boolean).join(" · "),
          sub: pending === null ? "" : pending ? `${pending} decisions not executed yet` : executed ? `${executed} decisions applied` : "nothing to execute",
          path: pending === null ? "unknown" : pending > 0 ? "review" : executed ? "executed" : "empty",
          pending,
        });
      }
    }

    for (const report of S.state.reports) {
      const candidates = report.candidates || 0;
      const sent = report.progressRejected || 0;
      const liveReport = /reject_finished|max_rejected_reached/.test(report.status);
      rows.push({
        id: `report:${report.path}`, when: report.createdAt, kind: "report", report, wfKey: "reject", label: "Auto-reject",
        mode: liveReport ? "live" : "dry run",
        outcome: `${report.checked} checked · ${candidates} candidates${sent ? ` · ${sent} sent` : ""}`,
        sub: S.reportStatusLabel(report.status),
        path: candidates === 0 ? "empty" : sent >= candidates || liveReport ? "executed" : "review",
        pending: Math.max(0, candidates - sent),
      });
    }

    for (const log of S.state.cliHistory) {
      const isReviewers = log.mode === "reviewers" || /^select-reviewers-/.test(log.filename);
      if (!isReviewers || log.status === "running") continue;
      rows.push({
        id: `log:${log.filename}`, when: log.startedAt, kind: "log", log, wfKey: "reviewers", label: "Reviewers", mode: "invite",
        outcome: [Number.isFinite(log.papersDone) ? `${log.papersDone} papers` : null, Number.isFinite(log.invited) ? `${log.invited} invited` : null].filter(Boolean).join(" · ") || log.status,
        sub: log.resultStatus ? log.resultStatus.replaceAll("_", " ") : log.status,
        path: log.status === "finished" ? "executed" : "failed",
      });
    }

    for (const job2 of S.state.jobs) {
      if (job2.status !== "failed" || (job && job.id === job2.id)) continue;
      rows.push({
        id: `job:${job2.id}`, when: job2.startedAt, kind: "failedjob", job: job2, wfKey: wfKeyForJob(job2.type),
        label: S.jobLabel(job2.type).split(", ")[0], mode: S.jobLabel(job2.type).split(", ")[1] || "",
        outcome: `failed, exit ${job2.exitCode ?? "?"}`, sub: S.progressText(job2.progress), path: "failed",
      });
    }

    return rows.sort((a, b) => new Date(b.when || 0) - new Date(a.when || 0));
  }

  function wfKeyForJob(type) {
    if (/^initial/.test(type)) return "screening";
    if (/^eic/.test(type)) return "eic";
    if (/^reviewers/.test(type)) return "reviewers";
    return "reject";
  }

  function stepsFor(row) {
    const step = (label, attrs = {}, mark = "") => el("span", { class: "step", dataset: attrs }, el("i", {}, mark), label);
    if (row.path === "live") return el("div", { class: "steps" }, step("running", { live: "true" }, "●"));
    if (row.path === "failed") return el("div", { class: "steps" }, step("failed", { bad: "true" }, "!"));
    if (row.path === "unknown") return el("div", { class: "steps" }, step(row.mode, { done: "true" }, "✓"), step("loading…"));
    if (row.path === "empty") return el("div", { class: "steps" }, step(row.mode, { done: "true" }, "✓"), step("nothing to do", { done: "true" }, "✓"));
    if (row.kind === "log") return el("div", { class: "steps" }, step("invited", { done: "true" }, "✓"));
    const reviewed = row.path === "executed";
    // A live run that stopped early still has decisions to execute, so it
    // walks the same review step as a dry run.
    if (row.mode === "live" && reviewed) return el("div", { class: "steps" }, step("live run", { done: "true" }, "✓"), step("executed", { done: "true" }, "✓"));
    return el("div", { class: "steps" },
      step(row.mode === "live" ? "live run" : "dry run", { done: "true" }, "✓"),
      step("review", { done: String(reviewed), now: String(!reviewed) }, reviewed ? "✓" : ""),
      step("executed", { done: String(reviewed) }, reviewed ? "✓" : ""));
  }

  function actionFor(row) {
    const running = S.jobRunning();
    if (row.kind === "job" && row.live) return el("button", { class: "btn small danger", type: "button", onclick: (e) => { e.stopPropagation(); S.stopJob().catch(showError); } }, "Stop");
    if (row.path === "review" && row.kind === "assessment") return el("button", { class: "btn small danger", type: "button", disabled: running, onclick: (e) => { e.stopPropagation(); S.executeRun(row.stage, row.run.filename, row.detail).catch(showError); } }, `Execute ${row.pending}`);
    if (row.path === "review" && row.kind === "report") return el("button", { class: "btn small danger", type: "button", disabled: running, onclick: (e) => { e.stopPropagation(); S.rejectFromReport(row.report.path).catch(showError); } }, `Reject ${row.pending}`);
    if (row.path === "failed") return el("button", { class: "btn small", type: "button", onclick: (e) => { e.stopPropagation(); openDrawer(row.wfKey); } }, "Retry");
    return null;
  }

  function renderLedger() {
    const rows = buildRows().filter((row) => ui.filter === "all" || (ui.filter === "review" ? row.path === "review" : row.wfKey === ui.filter));
    const ledger = $("ledger");
    ledger.replaceChildren(el("div", { class: "row head" }, el("span", {}, "When"), el("span", {}, "Run"), el("span", {}, "Outcome"), el("span", {}, "Path"), el("span")));
    if (!rows.length) {
      ledger.append(el("div", { class: "row empty" }, S.state.config ? "No runs yet. Start one with “New run”." : "Loading…"));
      return;
    }
    for (const row of rows) {
      const open = ui.expanded === row.id;
      const node = el("div", { class: `row run${row.live ? " live" : ""}`, tabindex: 0, "aria-expanded": String(open), dataset: { id: row.id },
        onclick: (e) => { if (e.target.closest("button, a, select, .detail, summary, input, textarea")) return; toggleRow(row.id); },
        onkeydown: (e) => { if (["Enter", " "].includes(e.key) && e.target === node) { e.preventDefault(); toggleRow(row.id); } },
      },
        el("span", { class: "when" }, row.when ? S.fmtDate(row.when) : "—"),
        el("div", { class: "what" }, el("b", {}, row.label), el("small", {}, row.mode)),
        el("div", { class: "outcome" }, row.outcome, el("small", {}, row.sub || "")),
        stepsFor(row),
        el("div", { class: "act" }, actionFor(row)));
      if (open) node.append(detailFor(row));
      ledger.append(node);
    }
  }

  function toggleRow(id) {
    ui.expanded = ui.expanded === id ? null : id;
    renderLedger();
  }

  // --- Row details -------------------------------------------------------------------

  // Meta strip: plain strings become spans so the flex gap separates them.
  function meta(...items) {
    return el("div", { class: "meta" }, items.filter((item) => item !== null && item !== undefined && item !== "").map((item) => (item instanceof Node ? item : el("span", {}, item))));
  }

  function detailFor(row) {
    const box = el("div", { class: "detail" });
    if (row.kind === "job") {
      const views = [["monitor", "Monitor"], ["log", "Job log"]];
      const toolbar = meta(
        el("div", { class: "seg", role: "tablist" }, views.map(([value, label]) => el("button", {
          type: "button", role: "tab", "aria-selected": String(ui.jobView === value),
          onclick: () => { ui.jobView = value; localStorage.setItem("s1.ledger.jobView", value); renderLedger(); },
        }, label))),
        `job ${row.job.id}`, `started ${S.fmtDate(row.job.startedAt)}`);
      toolbar.classList.add("detail-toolbar");
      box.append(toolbar);
      if (ui.jobView === "log") {
        const pre = el("pre", { class: "output", id: "jobOutput" }, row.job.output || "Job started…");
        box.append(pre);
        requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
      } else {
        box.append(el("div", { id: "jobMonitor" }, S.monitorPanel()));
      }
      return box;
    }
    if (row.kind === "cli") {
      box.append(el("div", { id: "jobMonitor" }, S.monitorPanel()));
      return box;
    }
    if (row.kind === "failedjob") {
      box.append(meta(`job ${row.job.id}`, `exit ${row.job.exitCode ?? "?"}`, S.progressText(row.job.progress)),
        el("p", { class: "settings-note" }, "The full output of past jobs is not stored. Look for the matching run in the log list below or start the job again."));
      return box;
    }
    if (row.kind === "log") {
      const loaded = ui.details.get(row.id);
      if (!loaded) {
        S.loadArchivedRun(row.log.filename).then((payload) => { ui.details.set(row.id, payload); renderLedger(); }).catch(showError);
        box.append(el("p", { class: "settings-note" }, "Loading log…"));
        return box;
      }
      box.append(meta(`${loaded.events.length} of ${loaded.totalEvents} events`, el("span", { class: "mono" }, row.log.filename)),
        el("div", { class: "log" }, loaded.events.length ? loaded.events.map(S.logRow) : el("p", { class: "log-empty" }, "This log has no readable events.")));
      return box;
    }
    if (row.kind === "report") {
      const report = row.report;
      box.append(meta(el("span", { class: "mono" }, report.path), `checked ${report.checked}`, `candidates ${report.candidates}`, `sent ${report.progressRejected || 0}`, report.progressSkipped ? `skipped ${report.progressSkipped}` : null),
        el("div", { class: "exec-bar", dataset: { quiet: String(row.path !== "review") } },
          el("div", {}, el("b", {}, row.path === "review" ? `${row.pending} candidates waiting for rejection` : row.path === "empty" ? "No candidates in this report" : "All candidates handled"),
            el("span", {}, "Rejects only the candidates listed in the report file. Manuscripts already sent are skipped.")),
          row.path === "review" ? el("button", { class: "btn danger", type: "button", disabled: S.jobRunning(), onclick: () => S.rejectFromReport(report.path).catch(showError) }, "Reject from this report") : null));
      return box;
    }
    // assessment
    if (!row.detail) {
      box.append(el("p", { class: "settings-note" }, "Loading run…"));
      return box;
    }
    const filter = ui.decisionFilter[row.id] || "";
    const rows = row.detail.manuscripts.filter((item) => !filter || (filter === "ERROR" ? Boolean(item.assessmentError || item.actionError) : item.decision === filter));
    box.append(
      el("div", { class: "filters" },
        el("select", { "aria-label": "Decision filter", onchange: (e) => { ui.decisionFilter[row.id] = e.target.value; renderLedger(); } },
          [["", "All decisions"], ["APPROVE", "APPROVE"], ["REJECT", "REJECT"], ["ERROR", "Errors"]].map(([value, label]) => el("option", { value, selected: filter === value }, label))),
        el("span", { class: "sum" }, S.runSummaryText(row.detail)), el("span", { class: "spacer" }),
        el("span", { class: "sum mono" }, row.run.filename)),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ...["Manuscript", "Decision", "Reason", "Tokens", "Action"].map((h) => el("th", { scope: "col" }, h)))),
        el("tbody", {}, rows.length ? rows.map(assessmentRow) : el("tr", {}, el("td", { class: "empty", colspan: 5 }, "No results for this filter."))))),
      el("div", { class: "exec-bar", dataset: { quiet: String(row.path !== "review") } },
        el("div", {}, el("b", {}, row.pending ? `${row.pending} decisions ready to execute` : "Nothing left to execute in this run"),
          el("span", {}, "Applies exactly these decisions. The model is not asked again; handled manuscripts are skipped.")),
        row.pending ? el("button", { class: "btn danger", type: "button", disabled: S.jobRunning(), onclick: () => S.executeRun(row.stage, row.run.filename, row.detail).catch(showError) }, "Execute these decisions") : null));
    return box;
  }

  function assessmentRow(item) {
    const decision = item.decision || (item.assessmentError ? "ERROR" : "—");
    return el("tr", {},
      el("td", {}, el("span", { class: "id" }, item.manuscriptId || "—"), el("span", { class: "title" }, item.title),
        el("details", {}, el("summary", {}, "abstract"), el("p", { class: "abstract" }, item.abstract || "(none)"))),
      el("td", {}, el("span", { class: "decision", dataset: { d: decision }, title: item.cached ? "result from cache" : "" }, decision)),
      el("td", { class: "reason" }, item.assessmentError || item.reason || "—"),
      el("td", { class: "num" }, item.cached ? "cache" : String(item.totalTokens ?? "—")),
      el("td", {}, item.actionError ? `failed: ${item.actionError}` : item.actionCompleted ? `done: ${item.actionDecision}` : "—"));
  }

  // Pending counts need each run's manuscripts, so details load right after the list.
  async function loadAllDetails() {
    const jobs = [];
    for (const stage of ["initial", "eic"]) {
      for (const run of S.state.runs[stage]) jobs.push(S.loadRun(stage, run.filename).catch(() => null));
    }
    await Promise.all(jobs);
    renderLedger();
  }

  function renderChips() {
    $("chips").replaceChildren(...FILTERS.map(([value, label]) => el("button", { class: "chip", type: "button", "aria-pressed": String(ui.filter === value), onclick: () => { ui.filter = value; renderChips(); renderLedger(); } }, label)));
  }

  function renderTop() {
    const top = $("topStatus");
    if (top.dataset.errorUntil && Date.now() < Number(top.dataset.errorUntil)) return;
    const job = S.state.job;
    top.dataset.tone = job && S.jobRunning(job) ? "active" : job?.status === "failed" ? "error" : "neutral";
    top.querySelector(".msg").textContent = job ? (S.jobRunning(job) ? `${S.jobLabel(job.type)} running` : `${S.jobLabel(job.type)} ${job.status}`) : "Ready";
  }

  function showError(error) {
    const top = $("topStatus");
    top.dataset.tone = "error";
    top.dataset.errorUntil = String(Date.now() + 8000);
    top.querySelector(".msg").textContent = error.message || String(error);
    setTimeout(() => { delete top.dataset.errorUntil; renderTop(); }, 8000);
    console.error(error);
  }

  // --- Wiring -----------------------------------------------------------------

  S.on("state", () => { renderLedger(); renderTop(); });
  S.on("runs", () => { renderLedger(); loadAllDetails().catch(() => undefined); });
  S.on("jobs", renderLedger);
  S.on("queues", () => { renderCounts(); renderMenu(); if (ui.drawerWf) { const count = S.queueCount(S.workflow(ui.drawerWf).queue); $("drawerSub").textContent = `${S.workflow(ui.drawerWf).queue}: ${count === null ? "unknown count" : `${count} manuscripts now`}. ${S.workflow(ui.drawerWf).summary}`; } });
  S.on("job", (job) => {
    renderTop();
    if (job && S.jobRunning(job)) ui.expanded = `job:${job.id}`;
    renderLedger();
    if (ui.drawerWf) openDrawer(ui.drawerWf);
  });
  S.on("job-output", ({ chunk, job }) => {
    const pre = $("jobOutput");
    if (!pre) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    if (pre.textContent === "Job started…") pre.textContent = "";
    pre.textContent += chunk;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
    const row = pre.closest(".row");
    const outcome = row?.querySelector(".outcome");
    if (outcome) outcome.replaceChildren(S.progressText(job.progress) || job.status, el("small", {}, "started from this panel"));
  });
  S.on("monitor", () => {
    const cliRow = S.state.cliRun?.effectiveStatus === "running" && !S.jobRunning();
    const shown = Boolean(document.querySelector('.row.live[data-id^="cli:"]'));
    if (cliRow !== shown) {
      renderLedger();
      return;
    }
    const jobMonitor = $("jobMonitor");
    if (jobMonitor) jobMonitor.replaceChildren(S.monitorPanel());
  });
  S.on("monitor-history", renderLedger);
  S.on("settings", (note) => { const target = $("settingsNote"); if (target) target.textContent = note; });
  S.on("values", ({ key }) => { if (key === null && ui.drawerWf) openDrawer(ui.drawerWf); });
  S.on("doctor", renderDoctor);
  S.on("error", showError);

  $("newRunBtn").addEventListener("click", () => toggleMenu());
  document.addEventListener("click", (e) => { if (!e.target.closest(".newrun")) toggleMenu(false); });
  $("drawerClose").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); toggleMenu(false); } });

  renderChips();
  renderCounts();
  renderLedger();
  S.init().catch(showError);
})();
