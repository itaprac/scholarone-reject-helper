// Shared mock data and a fake job runner for the UI prototypes.
// Numbers mirror a real ScholarOne status snapshot; manuscript titles are invented.

window.PROTO = (() => {
  const queues = [
    { key: "complete-checklist", label: "Complete Checklist", count: 1, workflow: "reject", focus: true },
    { key: "awaiting-eic-assignment", label: "Awaiting EIC Assignment", count: 3, workflow: "eic", focus: true },
    { key: "assign-reviewers", label: "Assign Reviewers", count: 9, workflow: "reviewers", focus: true },
    { key: "select-reviewers", label: "Select Reviewers", count: 29, workflow: "reviewers", focus: true },
    { key: "invite-reviewers", label: "Invite Reviewers", count: 1, workflow: "reviewers", focus: true },
    { key: "awaiting-reviewer-scores", label: "Awaiting Reviewer Scores", count: 10, workflow: "followup", focus: true },
    { key: "overdue-reviewer-scores", label: "Overdue Reviewer Scores", count: 26, workflow: "followup", focus: true },
    { key: "make-recommendation", label: "Make Recommendation", count: 16, workflow: "", focus: false },
    { key: "make-final-decision", label: "Make Final Decision", count: 4, workflow: "", focus: false },
    { key: "assign-ae", label: "Assign AE", count: 0, workflow: "", focus: false },
    { key: "rescinded-reviewer-scores", label: "Rescinded Reviewer Scores", count: 0, workflow: "", focus: false },
  ];

  const workflows = [
    {
      key: "reject",
      name: "Auto-reject",
      short: "Reject",
      queue: "Complete Checklist",
      summary: "Reject stale or flagged submissions by rule. No model involved.",
      dry: "Run dry run",
      live: "Run + reject",
      liveNote: "Sends rejection emails immediately.",
      fields: [
        { id: "maxChecked", label: "Max checked", type: "number", value: 50 },
        { id: "olderDays", label: "Older than days", type: "number", value: 30 },
        { id: "maxRejected", label: "Max rejected", type: "number", value: "", placeholder: "no limit" },
      ],
      advanced: [
        { id: "startUrl", label: "Start URL", type: "url", value: "https://mc.manuscriptcentral.com/kes", wide: true },
        { id: "queuePage", label: "Queue page", type: "number", value: "", placeholder: "auto" },
        { id: "slowMo", label: "Slow ms", type: "number", value: 500 },
      ],
      texts: [{ id: "rejectMessage", label: "Reject email body", rows: 10 }],
    },
    {
      key: "screening",
      name: "Initial assessment",
      short: "Initial",
      queue: "Complete Checklist",
      summary: "Collect title and abstract, assess each paper with Codex, save one batch.",
      dry: "Run assessment dry run",
      live: "Run live decisions",
      liveNote: "Approves and rejects in ScholarOne as the model decides.",
      fields: [
        { id: "scope", label: "Scan scope", type: "select", options: ["Entire queue", "Use safety limit"], value: "Entire queue" },
        { id: "limit", label: "Safety limit", type: "number", value: 10 },
        { id: "model", label: "Codex model", type: "text", value: "gpt-5.6-terra" },
        { id: "effort", label: "Reasoning effort", type: "select", options: ["Low", "Medium", "High"], value: "Medium" },
      ],
      advanced: [
        { id: "startUrl", label: "Start URL", type: "url", value: "https://mc.manuscriptcentral.com/kes", wide: true },
        { id: "slowMo", label: "Slow ms", type: "number", value: 500 },
        { id: "timeout", label: "LLM timeout (s)", type: "number", value: 120 },
      ],
      checks: [{ id: "approveWithoutAssign", label: "Approve without assigning editors", checked: true }],
      texts: [
        { id: "prompt", label: "Assessment rules", rows: 12 },
        { id: "email", label: "Live rejection email", rows: 8 },
      ],
    },
    {
      key: "eic",
      name: "EIC assessment",
      short: "EIC",
      queue: "Awaiting EIC Assignment",
      summary: "Second, stricter assessment. Both decisions assign EIC and AE first.",
      dry: "Run second assessment dry run",
      live: "Run live decisions",
      liveNote: "REJECT submits “Reject - Fatally Flawed” and emails the author.",
      fields: [
        { id: "scope", label: "Scan scope", type: "select", options: ["Entire queue", "Use safety limit"], value: "Entire queue" },
        { id: "limit", label: "Safety limit", type: "number", value: 100 },
        { id: "model", label: "Codex model", type: "text", value: "gpt-5.6-terra" },
        { id: "effort", label: "Reasoning effort", type: "select", options: ["Low", "Medium", "High"], value: "Medium" },
      ],
      advanced: [
        { id: "startUrl", label: "Start URL", type: "url", value: "https://mc.manuscriptcentral.com/kes", wide: true },
        { id: "slowMo", label: "Slow ms", type: "number", value: 500 },
        { id: "timeout", label: "LLM timeout (s)", type: "number", value: 120 },
      ],
      texts: [
        { id: "prompt", label: "Second assessment rules", rows: 12 },
        { id: "email", label: "Live rejection email", rows: 8 },
      ],
    },
    {
      key: "reviewers",
      name: "Reviewers",
      short: "Reviewers",
      queue: "Select Reviewers",
      summary: "Pick reviewers for each paper and send invitations, one paper at a time.",
      dry: "Prepare reviewer lists",
      live: "Invite reviewers",
      liveNote: "Sends real invitation emails.",
      fields: [
        { id: "queue", label: "Source queue", type: "select", options: ["Combined: Invite, then Select", "Select Reviewers", "Invite Reviewers"], value: "Combined: Invite, then Select" },
        { id: "papers", label: "Papers this run", type: "number", value: 3 },
        { id: "perPaper", label: "Reviewers per paper", type: "number", value: 10 },
      ],
      advanced: [
        { id: "startUrl", label: "Start URL", type: "url", value: "https://mc.manuscriptcentral.com/kes", wide: true },
        { id: "slowMo", label: "Slow ms", type: "number", value: 500 },
        { id: "refreshWait", label: "Refresh wait (s)", type: "number", value: 60 },
      ],
      texts: [],
    },
  ];

  const manuscripts = [
    { id: "KES-26-1229", title: "A Hybrid Deep Learning Framework for Lifetime-Aware Routing in Vehicular Networks", decision: "REJECT", tokens: 2140, reason: "ENGLISH 68/100; SCIENTIFIC 42/100; FINAL 47.2/100. The abstract is understandable but the contribution is a routine ensemble; results are simulation-only with no baseline detail.", action: "" },
    { id: "KES-26-1226", title: "Knowledge Graph Completion with Contrastive Relation Prototypes", decision: "APPROVE", tokens: 1980, reason: "ENGLISH 86/100; SCIENTIFIC 74/100; FINAL 76.4/100. Clear problem statement, credible benchmark comparison, novelty is modest but real.", action: "" },
    { id: "KES-26-1224", title: "Fuzzy Cognitive Maps for Supplier Risk Ranking under Uncertainty", decision: "APPROVE", tokens: 1750, reason: "ENGLISH 80/100; SCIENTIFIC 70/100; FINAL 72.0/100. Fits the journal scope; method described precisely.", action: "done: APPROVE" },
    { id: "KES-26-1221", title: "An Optimized CNN for Plant Leaf Disease Detection Using Transfer Learning", decision: "REJECT", tokens: 1620, reason: "ENGLISH 72/100; SCIENTIFIC 35/100; FINAL 42.4/100. Well-trodden application with no methodological novelty.", action: "done: REJECT" },
    { id: "KES-26-1219", title: "Explainable Reinforcement Learning for Elevator Group Control", decision: "", tokens: 0, reason: "Codex CLI timed out after 120 s.", action: "", error: true },
    { id: "KES-26-1217", title: "Multi-Criteria Evaluation of Renewable Energy Sites with Interval-Valued Data", decision: "APPROVE", tokens: 2010, reason: "ENGLISH 84/100; SCIENTIFIC 71/100; FINAL 73.6/100. Sound MCDA setup, real case data.", action: "" },
  ];

  const runs = [
    { id: "2026-09-04T22-17-14-950Z", type: "screening", label: "Initial assessment", mode: "dry run", at: "2026-09-05T00:17", papers: 6, approve: 3, reject: 2, errors: 1, pending: 3, executed: 2 },
    { id: "2026-09-04T15-42-59-273Z", type: "screening", label: "Initial assessment", mode: "live", at: "2026-09-04T17:43", papers: 4, approve: 2, reject: 2, errors: 0, pending: 0, executed: 4 },
    { id: "2026-08-31T13-38-10-267Z", type: "eic", label: "EIC assessment", mode: "dry run", at: "2026-08-31T15:38", papers: 24, approve: 15, reject: 9, errors: 0, pending: 24, executed: 0 },
  ];

  const reports = [
    { id: "2026-09-04T22-16-51-725Z", at: "2026-09-05T00:16", status: "Queue completed", checked: 1, candidates: 0, sent: 0, skipped: 0 },
    { id: "2026-08-26T07-05-01-345Z", at: "2026-08-26T09:05", status: "Dry run finished", checked: 50, candidates: 7, sent: 7, skipped: 0 },
    { id: "2026-08-24T09-21-46-454Z", at: "2026-08-24T11:21", status: "Check limit reached", checked: 50, candidates: 12, sent: 0, skipped: 0 },
  ];

  const history = [
    { when: "2026-09-05T00:28", type: "reviewers-invite", label: "Reviewers, invite", status: "running", outcome: "1 of 50 papers done" },
    { when: "2026-09-05T00:17", type: "initial-assessment-dry", label: "Initial assessment, dry run", status: "finished", outcome: "6 papers, 1 error" },
    { when: "2026-09-05T00:16", type: "reject-dry", label: "Auto-reject, dry run", status: "finished", outcome: "1 checked, 0 candidates" },
    { when: "2026-09-04T17:43", type: "initial-assessment-live", label: "Initial assessment, live", status: "finished", outcome: "4 decisions applied" },
    { when: "2026-09-04T17:24", type: "reviewers-invite", label: "Reviewers, invite", status: "failed", outcome: "exit 1, popup not confirmed" },
    { when: "2026-08-31T15:38", type: "eic-dry", label: "EIC assessment, dry run", status: "finished", outcome: "24 papers" },
  ];

  const eventScript = [
    { type: "browser_started", text: "Chromium profile opened" },
    { type: "login_ok", text: "Signed in as editor", tone: "ok" },
    { type: "queue_opened", text: "Complete Checklist, page 1" },
    { type: "manuscript_opened", id: "KES-26-1229", text: "View details" },
    { type: "metadata_collected", id: "KES-26-1229", text: "title + abstract, 1 412 chars" },
    { type: "llm_request", id: "KES-26-1229", text: "codex exec, gpt-5.6-terra, medium" },
    { type: "llm_decision", id: "KES-26-1229", text: "REJECT, 2 140 tokens", tone: "warn" },
    { type: "manuscript_opened", id: "KES-26-1226", text: "View details" },
    { type: "metadata_collected", id: "KES-26-1226", text: "title + abstract, 1 098 chars" },
    { type: "llm_request", id: "KES-26-1226", text: "codex exec, gpt-5.6-terra, medium" },
    { type: "llm_decision", id: "KES-26-1226", text: "APPROVE, 1 980 tokens", tone: "ok" },
    { type: "queue_end", text: "No more View details links" },
    { type: "batch_saved", text: "logs/screening/2026-09-05T08-12-40-118Z.json", tone: "ok" },
    { type: "run_finished", text: "assessment_batch_completed", tone: "ok" },
  ];

  // Fake job: emits eventScript over ~7 s. Returns a controller with stop().
  function startFakeJob({ onEvent, onDone, intervalMs = 520 }) {
    let i = 0;
    let stopped = false;
    const startedAt = new Date();
    const timer = setInterval(() => {
      if (stopped) return;
      const event = eventScript[i];
      if (!event) {
        clearInterval(timer);
        onDone?.({ status: "finished", exitCode: 0, startedAt });
        return;
      }
      onEvent?.({ ...event, at: new Date(), index: i, total: eventScript.length });
      i += 1;
    }, intervalMs);
    return {
      startedAt,
      stop() {
        stopped = true;
        clearInterval(timer);
        onDone?.({ status: "stopped", exitCode: 130, startedAt });
      },
    };
  }

  function fmtTime(date) {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
  }

  function fmtWhen(iso) {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
  }

  const defaultPrompt = "You are conducting a preliminary editorial screening of a manuscript submitted to the International Journal of Knowledge-Based and Intelligent Engineering Systems.\n\nYou will receive the manuscript TITLE and ABSTRACT. Based only on these, decide whether the manuscript should be REJECTED during preliminary screening or SENT FOR REVIEW.\n\n1. English-language quality, weight 0.2\n2. Scientific contribution, weight 0.8\n\nReturn strict JSON.";
  const defaultEmail = "Dear Author,\n\nThank you for submitting your manuscript to the International Journal of Knowledge-Based and Intelligent Engineering Systems. After preliminary screening, the editors have decided not to send the manuscript for review.\n\nKind regards,\nEditorial Office";

  return { queues, workflows, manuscripts, runs, reports, history, eventScript, startFakeJob, fmtTime, fmtWhen, defaultPrompt, defaultEmail };
})();
