import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REJECT_MESSAGE } from "./default-message.js";
import {
  buildEicAssessmentJobArgs,
  buildAssessmentFromRunArgs,
  buildJobArgs,
  buildReviewerJobArgs,
  buildScreeningJobArgs,
} from "./job-args.js";
import { validateRunOptions } from "./run-options.js";
import { buildPublicConfig, normalizeUiSettings } from "./config/ui-settings.js";
import { describeFields } from "./config/options.js";
import { runDoctorChecks } from "./doctor.js";
import { applyProgressLine, createProgressState } from "./job-progress.js";
import { tailSince } from "./job-tail.js";
import { listScreeningRuns, readScreeningRun } from "./screening-runs.js";
import { buildRunConfig } from "./config/run-config.js";
import { fetchScholarOneStatus } from "./scholarone-status.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const uiRoot = path.join(projectRoot, "ui");
const reportsDir = path.join(projectRoot, "logs", "reports");
const autoRejectScript = path.join(projectRoot, "src", "auto-reject.js");
const scholarOneScript = path.join(projectRoot, "src", "scholarone.js");
const settingsPath = path.join(projectRoot, "ui-settings.json");
const jobsDir = path.join(projectRoot, "logs", "jobs");
const preferredPort = Number.parseInt(process.env.UI_PORT || "3131", 10);
const maxPort = preferredPort + 20;
const listenHost = "127.0.0.1";
const envDefaults = loadEnvFile(path.join(projectRoot, ".env"));

const jobs = new Map();
let activeJobId = null;
let nextJobId = 1;
let scholarOneStatusCache = null;
let scholarOneStatusRefresh = null;
const scholarOneStatusCacheMs = 2 * 60 * 1000;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(req.method || "")) {
      assertSameOrigin(req);
    }

    if (url.pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, {
        config: await publicConfig(),
        reports: await listReports(),
        activeJob: activeJobId ? publicJob(jobs.get(activeJobId)) : null,
      });
    }

    // Opis pól formularza pochodzi z tej samej definicji co walidacja i
    // argumenty CLI, więc panel nie może pokazać opcji, której backend nie zna.
    if (url.pathname === "/api/fields" && req.method === "GET") {
      return sendJson(res, {
        reject: describeFields("live"),
        screening: describeFields("screening"),
        eicAssessment: describeFields("eic-assessment"),
        reviewers: describeFields("reviewers-invite"),
      });
    }

    if (url.pathname === "/api/screening/runs" && req.method === "GET") {
      return sendJson(res, { runs: await listScreeningRuns(path.join(projectRoot, "logs")) });
    }

    const screeningMatch = url.pathname.match(/^\/api\/screening\/runs\/([^/]+)$/);
    if (screeningMatch && req.method === "GET") {
      const run = await readScreeningRun(path.join(projectRoot, "logs"), decodeURIComponent(screeningMatch[1]));
      return sendJson(res, { run });
    }

    if (url.pathname === "/api/eic-assessment/runs" && req.method === "GET") {
      return sendJson(res, {
        runs: await listScreeningRuns(path.join(projectRoot, "logs"), { stage: "eic" }),
      });
    }

    const eicAssessmentMatch = url.pathname.match(/^\/api\/eic-assessment\/runs\/([^/]+)$/);
    if (eicAssessmentMatch && req.method === "GET") {
      const run = await readScreeningRun(
        path.join(projectRoot, "logs"),
        decodeURIComponent(eicAssessmentMatch[1]),
        { stage: "eic" }
      );
      return sendJson(res, { run });
    }

    // Puls przebiegu z CLI: joby z panelu widać przez /api/jobs, ale przebieg
    // odpalony z terminala byłby niewidoczny. Ten endpoint czyta
    // logs/current-run.json pisany przez każdy przebieg i dokłada ogon zdarzeń.
    if (url.pathname === "/api/cli-run" && req.method === "GET") {
      const tail = clampInt(url.searchParams.get("tail"), 40, 1, 200);
      return sendJson(res, await readCliRun(tail));
    }

    // Historia przebiegów: te same pliki JSONL, które zasilają monitor na
    // żywo, dostępne również po zakończeniu przebiegu.
    if (url.pathname === "/api/cli-run/history" && req.method === "GET") {
      return sendJson(res, { runs: await listRunLogs() });
    }

    const runLogMatch = url.pathname.match(/^\/api\/cli-run\/history\/([^/]+)$/);
    if (runLogMatch && req.method === "GET") {
      const tail = clampInt(url.searchParams.get("tail"), 500, 1, 2000);
      return sendJson(res, await readArchivedRun(decodeURIComponent(runLogMatch[1]), tail));
    }

    if (url.pathname === "/api/doctor" && req.method === "GET") {
      return sendJson(res, { checks: await runDoctorChecks() });
    }

    if (url.pathname === "/api/scholarone/status" && req.method === "GET") {
      return sendJson(res, await readScholarOneStatus({
        force: url.searchParams.get("refresh") === "1",
      }));
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      const body = await readJsonBody(req);
      await saveUiSettings(body);
      return sendJson(res, { config: await publicConfig(), saved: true });
    }

    if (url.pathname === "/api/settings/reset" && req.method === "POST") {
      await fsp.rm(settingsPath, { force: true });
      return sendJson(res, { config: await publicConfig(), reset: true });
    }

    if (url.pathname === "/api/run/dryrun" && req.method === "POST") {
      const body = await readJsonBody(req);
      validateRunOptions(body, "dryrun");
      const args = buildJobArgs("dryrun", body);
      return sendJson(res, { job: startJob("dryrun", args) });
    }

    if (url.pathname === "/api/run/live" && req.method === "POST") {
      const body = await readJsonBody(req);
      validateRunOptions(body, "live");
      const args = buildJobArgs("live", body);
      return sendJson(res, { job: startJob("live-reject", args) });
    }

    if (url.pathname === "/api/run/send-from-report" && req.method === "POST") {
      const body = await readJsonBody(req);
      validateRunOptions(body, "send-from-report");
      const reportPath = resolveReportPath(body.report);
      const args = buildJobArgs("send-from-report", body, {
        report: relativeProjectPath(reportPath),
      });
      return sendJson(res, { job: startJob("reject-from-report", args) });
    }

    if (url.pathname === "/api/run/reviewers/invite" && req.method === "POST") {
      const body = await readJsonBody(req);
      validateRunOptions(body, "reviewers-invite");
      const args = buildReviewerJobArgs("reviewers-invite", body);
      return sendJson(res, { job: startJob("reviewers-invite", args, scholarOneScript) });
    }

    if (url.pathname === "/api/run/screening/collect" && req.method === "POST") {
      const body = await readJsonBody(req);
      validateRunOptions(body, "screening");
      const args = buildScreeningJobArgs(body);
      return sendJson(res, { job: startJob("initial-assessment-dryrun", args) });
    }

    if (url.pathname === "/api/run/screening/live" && req.method === "POST") {
      const body = await readJsonBody(req);
      body.screeningLive = true;
      validateRunOptions(body, "screening");
      const args = buildScreeningJobArgs(body, { applyDecisions: true });
      return sendJson(res, { job: startJob("initial-assessment-live", args) });
    }

    if (url.pathname === "/api/run/screening/execute" && req.method === "POST") {
      const body = await readJsonBody(req);
      const runPath = resolveScreeningRunPath(body.run);
      body.screeningLive = true;
      validateRunOptions(body, "screening");
      const args = buildAssessmentFromRunArgs(body, {
        run: relativeProjectPath(runPath),
      });
      return sendJson(res, { job: startJob("initial-assessment-from-run", args) });
    }

    if (url.pathname === "/api/run/eic-assessment/collect" && req.method === "POST") {
      const body = await readJsonBody(req);
      validateRunOptions(body, "eic-assessment");
      const args = buildEicAssessmentJobArgs(body);
      return sendJson(res, { job: startJob("eic-assessment-dryrun", args) });
    }

    if (url.pathname === "/api/run/eic-assessment/live" && req.method === "POST") {
      const body = await readJsonBody(req);
      body.eicAssessmentLive = true;
      validateRunOptions(body, "eic-assessment");
      const args = buildEicAssessmentJobArgs(body, { applyDecisions: true });
      return sendJson(res, { job: startJob("eic-assessment-live", args) });
    }

    if (url.pathname === "/api/run/eic-assessment/execute" && req.method === "POST") {
      const body = await readJsonBody(req);
      const runPath = resolveAssessmentRunPath(body.run, "eic");
      body.eicAssessmentLive = true;
      validateRunOptions(body, "eic-assessment");
      const args = buildAssessmentFromRunArgs(body, {
        run: relativeProjectPath(runPath),
        stage: "eic",
      });
      return sendJson(res, { job: startJob("eic-assessment-from-run", args) });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === "GET") {
      const job = jobs.get(jobMatch[1]);
      const since = Number.parseInt(url.searchParams.get("since") || "", 10);
      return sendJson(res, { job: publicJob(job, { since }) });
    }

    const streamMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/stream$/);
    if (streamMatch && req.method === "GET") {
      return streamJob(res, jobs.get(streamMatch[1]));
    }

    if (url.pathname === "/api/jobs" && req.method === "GET") {
      return sendJson(res, { jobs: await listJobHistory() });
    }

    const stopMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/stop$/);
    if (stopMatch && req.method === "POST") {
      const job = jobs.get(stopMatch[1]);
      if (job?.child && job.status === "running") {
        job.status = "stopping";
        job.child.kill("SIGTERM");
      }
      return sendJson(res, { job: publicJob(job) });
    }

    return serveStatic(req, res, url);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.statusCode || 500);
  }
});

let currentPort = preferredPort;

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && currentPort < maxPort) {
    const nextPort = currentPort + 1;
    console.warn(`Port ${currentPort} jest zajety, probuje ${nextPort}...`);
    currentPort = nextPort;
    server.listen(currentPort, listenHost);
    return;
  }

  console.error(error);
  process.exit(1);
});

server.listen(currentPort, listenHost, () => {
  console.log(`ScholarOne helper UI: http://localhost:${currentPort}`);
});

async function listReports() {
  await fsp.mkdir(reportsDir, { recursive: true });
  const files = await fsp.readdir(reportsDir);
  const reports = [];

  for (const filename of files) {
    if (!/\.json$/i.test(filename) || /\.progress\.json$/i.test(filename)) {
      continue;
    }

    const absolutePath = path.join(reportsDir, filename);
    const stat = await fsp.stat(absolutePath);
    const payload = await readJsonFile(absolutePath);
    const result = payload?.result || {};

    // Przebiegi wyboru recenzentów zapisują się do tego samego katalogu, ale
    // nie mają czego odrzucać. Bez tego filtra zajmowały większość tabeli
    // wierszami z zerami, których nie da się użyć.
    if (!result.report) continue;
    const summary = result.summary || buildSummaryFromResult(result);
    const progressPath = absolutePath.replace(/\.json$/i, ".progress.json");
    const progress = await readJsonFile(progressPath);
    const progressValues = Object.values(progress?.manuscripts || {});

    reports.push({
      filename,
      path: relativeProjectPath(absolutePath),
      progressPath: fs.existsSync(progressPath) ? relativeProjectPath(progressPath) : null,
      createdAt: payload?.createdAt || stat.mtime.toISOString(),
      status: result.status || "",
      checked: summary.checked || 0,
      candidates: summary.wouldReject || 0,
      progressRejected: progressValues.filter((entry) => entry?.status === "sent").length,
      progressSkipped: progressValues.filter((entry) => entry?.status === "not_actionable_no_reject_control").length,
    });
  }

  return reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function readCliRun(tail) {
  const run = await readJsonFile(path.join(projectRoot, "logs", "current-run.json"));
  if (!run || typeof run !== "object") {
    return { run: null, events: [] };
  }

  const alive = isProcessAlive(run.pid);
  const effectiveStatus = run.status === "running" && !alive ? "dead" : run.status;
  return {
    run: { ...run, alive, effectiveStatus },
    events: await readRunEvents(run.logFile, tail),
  };
}

// Lista zarchiwizowanych logów przebiegów. Metadane pochodzą z pierwszego
// i ostatniego zdarzenia pliku; przebieg wskazywany przez current-run.json
// jako żywy jest oznaczany "running", żeby nie wyglądał na przerwany.
async function listRunLogs(limit = 40) {
  const logsDir = path.join(projectRoot, "logs");
  const names = await fsp.readdir(logsDir).catch(() => []);
  const current = await readJsonFile(path.join(projectRoot, "logs", "current-run.json"));
  const currentLogName = typeof current?.logFile === "string" ? path.basename(current.logFile) : null;
  const currentRunning = current?.status === "running" && isProcessAlive(current.pid);

  // Tylko logi przebiegów (nazwane znacznikiem czasu startu) — w logs/ leżą
  // też inne pliki JSONL, np. dziennik akcji.
  const runLogPattern = /^(select-reviewers-)?\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/i;

  const runs = [];
  for (const filename of names.filter((name) => runLogPattern.test(name))) {
    const absolutePath = path.join(logsDir, filename);
    const stat = await fsp.stat(absolutePath).catch(() => null);
    if (!stat) continue;
    const lines = await readRunLogLines(absolutePath);
    if (lines.length === 0) continue;
    const meta = runLogMeta(filename, lines, stat.mtime);
    if (filename === currentLogName && currentRunning) {
      meta.status = "running";
    }
    runs.push(meta);
  }

  return runs
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, limit);
}

async function readArchivedRun(filename, tail) {
  const logsDir = path.join(projectRoot, "logs");
  const absolutePath = path.resolve(logsDir, path.basename(String(filename)));
  const relative = path.relative(logsDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.jsonl$/i.test(absolutePath)) {
    throw badRequest("Log przebiegu musi byc plikiem JSONL z logs/.");
  }

  const stat = await fsp.stat(absolutePath).catch(() => null);
  if (!stat) {
    throw badRequest("Nie znaleziono logu przebiegu.");
  }

  const lines = await readRunLogLines(absolutePath);
  const events = lines
    .slice(-tail)
    .map(parseJsonLine)
    .filter(Boolean)
    .map(compactEvent);

  const run = runLogMeta(path.basename(absolutePath), lines, stat.mtime);
  if (run.mode === "reviewers") {
    Object.assign(run, reviewerCounters(lines.map(parseJsonLine).filter(Boolean)));
  }

  return { run, events, totalEvents: lines.length };
}

// Odpowiednik liczników recenzentów z core/run-status.js, odtworzony z pełnego
// logu — stare przebiegi nie mają pulsu, więc trzeba je policzyć ze zdarzeń.
function reviewerCounters(events) {
  const counters = { papersDone: 0, papersRequested: null, invited: 0 };
  for (const event of events) {
    if (
      ["batch_manuscript_finished", "deferred_reviewer_finished"].includes(event.type) &&
      event.status !== "reviewer_search_deferred"
    ) {
      counters.papersDone += 1;
    }
    if (Number.isFinite(event.completed)) {
      counters.papersDone = Math.max(counters.papersDone, event.completed);
    }
    if (Number.isFinite(event.requested)) {
      counters.papersRequested = event.requested;
    }
    if (event.type === "invite_all_verification" && Number.isFinite(event.invitedIncrease) && event.invitedIncrease > 0) {
      counters.invited += event.invitedIncrease;
    }
  }
  return counters;
}

async function readRunLogLines(absolutePath) {
  try {
    const content = await fsp.readFile(absolutePath, "utf8");
    return content.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function runLogMeta(filename, lines, mtime) {
  const first = parseJsonLine(lines[0]);
  const last = parseJsonLine(lines[lines.length - 1]);
  const final = last && ["run_finished", "run_failed"].includes(last.type) ? last : null;

  return {
    filename,
    runId: filename.replace(/\.jsonl$/i, ""),
    mode: runLogMode(filename, first),
    status: final ? (final.type === "run_finished" ? "finished" : "failed") : "interrupted",
    resultStatus: typeof final?.status === "string" ? final.status : null,
    startedAt: first?.at || mtime.toISOString(),
    finishedAt: final?.at || mtime.toISOString(),
    checked: Number.isFinite(final?.checked) ? final.checked : null,
    rejected: Number.isFinite(final?.rejected) ? final.rejected : null,
    eventCount: lines.length,
  };
}

// Odpowiednik describeMode z run-reject.js, odtworzony z zapisu run_started —
// stare logi nie mają pola mode, więc trzeba go wywnioskować z flag.
function runLogMode(filename, first) {
  if (/^select-reviewers-/i.test(filename)) return "reviewers";
  if (!first || first.type !== "run_started") return null;
  if (first.collectMetadata) {
    const prefix = first.assessmentStage === "eic" ? "eic-assessment" : "screening";
    return first.applyAssessmentDecisions ? `${prefix}-live` : `${prefix}-dryrun`;
  }
  if (first.rejectFromReport || first.rejectIdsCount) return "reject-from-report";
  if (first.reportOnly) return "reject-dryrun";
  if (first.saveAndSend) return "live-reject";
  return "scan";
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM oznacza "istnieje, ale nie mój" — wciąż żywy.
    return error.code === "EPERM";
  }
}

async function readRunEvents(logFile, tail) {
  if (typeof logFile !== "string" || !logFile) {
    return [];
  }

  // Ścieżka pochodzi z pliku pulsu, ale i tak musi wskazywać JSONL w logs —
  // panel nie może czytać dowolnych plików z dysku.
  const logsDir = path.join(projectRoot, "logs");
  const absolutePath = path.resolve(projectRoot, logFile);
  const relative = path.relative(logsDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.jsonl$/i.test(absolutePath)) {
    return [];
  }

  let content = "";
  try {
    content = await fsp.readFile(absolutePath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split(/\r?\n/).filter(Boolean).slice(-tail);
  const events = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(compactEvent(entry));
  }
  return events;
}

function compactEvent(entry) {
  const slim = {
    at: entry.at,
    type: entry.type,
    manuscriptId: entry.manuscriptId ?? entry.details?.manuscriptId,
    reason: entry.reason ?? entry.details?.reason,
    status: typeof entry.status === "string" ? entry.status : undefined,
    checked: entry.checked,
    rejected: entry.rejected,
    message: entry.message,
    note: entry.note,
  };
  return Object.fromEntries(
    Object.entries(slim).filter(([, value]) => value !== undefined && value !== null)
  );
}

function clampInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

async function publicConfig() {
  const saved = await readJsonFile(settingsPath) || {};
  return {
    settingsPath: relativeProjectPath(settingsPath),
    settingsSaved: fs.existsSync(settingsPath),
    ...buildPublicConfig({ saved, envValue, rejectMessage: loadRejectMessage }),
  };
}

async function readScholarOneStatus({ force = false } = {}) {
  const cacheAge = scholarOneStatusCache
    ? Date.now() - new Date(scholarOneStatusCache.fetchedAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (!force && cacheAge < scholarOneStatusCacheMs) {
    return scholarOneStatusCache;
  }

  const running = activeJobId ? jobs.get(activeJobId) : null;
  if (running && ["running", "stopping"].includes(running.status)) {
    return unavailableScholarOneStatus(
      "busy",
      "Status odświeży się po zakończeniu aktywnego joba, który używa profilu ScholarOne."
    );
  }

  if (scholarOneStatusRefresh) return scholarOneStatusRefresh;

  scholarOneStatusRefresh = (async () => {
    try {
      const runConfig = buildRunConfig([], { envFile: path.join(projectRoot, ".env") });
      const uiConfig = await publicConfig();
      const status = await fetchScholarOneStatus({
        startUrl: uiConfig.startUrl || runConfig.startUrl,
        profileDir: runConfig.profileDir,
        browserChannel: runConfig.browserChannel,
        credentials: {
          username: runConfig.loginUsername,
          password: runConfig.loginPassword,
        },
        autoLogin: runConfig.autoLogin,
      });
      scholarOneStatusCache = status;
      return status;
    } catch (error) {
      return unavailableScholarOneStatus(
        error.code || "unavailable",
        error.message || "Nie udało się odczytać statusu ScholarOne."
      );
    } finally {
      scholarOneStatusRefresh = null;
    }
  })();

  return scholarOneStatusRefresh;
}

function unavailableScholarOneStatus(state, message) {
  return {
    state,
    message,
    attemptedAt: new Date().toISOString(),
    stale: Boolean(scholarOneStatusCache),
    fetchedAt: scholarOneStatusCache?.fetchedAt || null,
    source: scholarOneStatusCache?.source || null,
    queues: scholarOneStatusCache?.queues || [],
  };
}

async function saveUiSettings(body) {
  const settings = normalizeUiSettings(body, { rejectMessage: loadRejectMessage });
  await fsp.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function buildSummaryFromResult(result) {
  const report = result.report || {};
  return {
    checked: result.checked || 0,
    wouldReject: report.candidates?.length || 0,
  };
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function startJob(type, args, script = autoRejectScript) {
  const running = activeJobId ? jobs.get(activeJobId) : null;
  if (running && ["running", "stopping"].includes(running.status)) {
    const error = new Error(`Job ${activeJobId} is still running.`);
    error.statusCode = 409;
    throw error;
  }

  const id = String(nextJobId++);
  const child = spawn(process.execPath, [script, ...args], {
    cwd: projectRoot,
    env: process.env,
  });

  const job = {
    id,
    type,
    args,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: "",
    // Licznik bajtów rośnie także wtedy, gdy bufor jest przycinany — dzięki
    // temu klient może dopytywać o sam ogon zamiast pobierać całość co 1,5 s.
    offset: 0,
    progress: createProgressState(),
    subscribers: new Set(),
    partialLine: "",
    child,
  };

  jobs.set(id, job);
  activeJobId = id;

  const append = (chunk) => {
    const text = chunk.toString();
    job.output += text;
    // Offset liczony w znakach, nie w bajtach — musi być w tej samej jednostce
    // co job.output.length, bo na tej różnicy opiera się wycinanie ogona.
    // Polskie znaki w logach zajmują 2 bajty, więc licznik bajtowy ucinałby
    // przyrost w złym miejscu.
    job.offset += text.length;
    if (job.output.length > 120_000) {
      job.output = job.output.slice(-120_000);
    }

    // Postęp liczymy z pełnych linii; ostatni, urwany fragment czeka na resztę.
    const lines = (job.partialLine + text).split(/\r?\n/);
    job.partialLine = lines.pop() || "";
    for (const line of lines) {
      applyProgressLine(job.progress, line);
    }

    broadcast(job, { type: "output", chunk: text, offset: job.offset, progress: job.progress });
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("close", async (code) => {
    job.status = job.status === "stopping" ? "stopped" : code === 0 ? "finished" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.child = null;
    if (activeJobId === id) {
      activeJobId = null;
    }

    broadcast(job, { type: "status", job: publicJob(job) });
    for (const response of job.subscribers) response.end();
    job.subscribers.clear();

    await persistJob(job).catch(() => undefined);
  });

  return publicJob(job);
}

function broadcast(job, payload) {
  for (const response of job.subscribers) {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

// Joby żyły dotąd wyłącznie w pamięci — restart panelu kasował historię i
// zrywał związek między uruchomieniem a plikami, które wyprodukowało.
async function persistJob(job) {
  await fsp.mkdir(jobsDir, { recursive: true });
  await fsp.writeFile(
    path.join(jobsDir, `${job.id}.json`),
    `${JSON.stringify({ ...publicJob(job), progress: job.progress }, null, 2)}\n`,
    "utf8"
  );
}

async function listJobHistory(limit = 20) {
  const files = await fsp.readdir(jobsDir).catch(() => []);
  const entries = [];

  for (const filename of files.filter((name) => name.endsWith(".json"))) {
    const payload = await readJsonFile(path.join(jobsDir, filename));
    if (!payload) continue;
    entries.push({
      id: payload.id,
      type: payload.type,
      status: payload.status,
      startedAt: payload.startedAt,
      finishedAt: payload.finishedAt,
      exitCode: payload.exitCode,
      progress: payload.progress || null,
    });
  }

  return entries
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, limit);
}

function publicJob(job, { since = Number.NaN } = {}) {
  if (!job) {
    return null;
  }

  // Klient, który podał znany mu offset, dostaje tylko przyrost.
  const output = tailSince(job.output, job.offset, since);

  return {
    id: job.id,
    type: job.type,
    args: job.args,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    output,
    offset: job.offset,
    progress: job.progress,
  };
}



function streamJob(res, job) {
  if (!job) {
    res.writeHead(404);
    res.end();
    return undefined;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });

  res.write(`data: ${JSON.stringify({ type: "snapshot", job: publicJob(job) })}\n\n`);

  if (job.status === "running" || job.status === "stopping") {
    job.subscribers.add(res);
    res.on("close", () => job.subscribers.delete(res));
  } else {
    res.end();
  }
  return undefined;
}

function envValue(key, fallback = "") {
  const value = process.env[key] ?? envDefaults[key];
  return value === undefined || value === null ? fallback : String(value);
}

function loadRejectMessage() {
  const messageFile = envValue("REJECT_MESSAGE_FILE", "");
  if (messageFile) {
    const absolutePath = path.isAbsolute(messageFile)
      ? messageFile
      : path.join(projectRoot, messageFile);
    try {
      return fs.readFileSync(absolutePath, "utf8").trimEnd();
    } catch {
      return DEFAULT_REJECT_MESSAGE;
    }
  }

  const inlineMessage = envValue("REJECT_MESSAGE", "");
  if (inlineMessage) {
    return inlineMessage.replace(/\\n/g, "\n");
  }

  return DEFAULT_REJECT_MESSAGE;
}


function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return Object.fromEntries(
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const index = line.indexOf("=");
          if (index === -1) {
            return [line, ""];
          }
          return [line.slice(0, index), line.slice(index + 1)];
        })
    );
  } catch {
    return {};
  }
}

function resolveReportPath(value) {
  if (!value) {
    throw new Error("Wybierz raport.");
  }

  const absolutePath = path.resolve(projectRoot, value);
  const relative = path.relative(reportsDir, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.(json|csv)$/i.test(absolutePath)) {
    throw new Error("Raport musi byc plikiem JSON/CSV z logs/reports.");
  }
  return absolutePath;
}

// Ścieżka musi wskazywać plik wyniku w logs/screening — bez tego panel mógłby
// kazać wykonać dowolny plik z dysku.
function resolveScreeningRunPath(value) {
  return resolveAssessmentRunPath(value, "initial");
}

function resolveAssessmentRunPath(value, stage) {
  if (!value) throw badRequest("Wybierz zapisany przebieg oceny.");

  const directoryName = stage === "eic" ? "eic-assessment" : "screening";
  const screeningDir = path.join(projectRoot, "logs", directoryName);
  const absolutePath = path.resolve(screeningDir, path.basename(String(value)));
  const relative = path.relative(screeningDir, absolutePath);

  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.json$/i.test(absolutePath)) {
    throw badRequest(`Przebieg musi byc plikiem JSON z logs/${directoryName}.`);
  }
  if (!fs.existsSync(absolutePath)) {
    throw badRequest("Nie znaleziono wskazanego przebiegu oceny.");
  }
  return absolutePath;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function relativeProjectPath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden("Niepoprawny naglowek Origin.");
  }

  if (originHost !== req.headers.host) {
    throw forbidden("Zadanie zostalo odrzucone, bo pochodzi z innego originu.");
  }
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  // Directory paths ("/", "/prototypes/") resolve to their index.html.
  if (pathname.endsWith("/")) {
    pathname = `${pathname}index.html`;
  }

  const filePath = path.resolve(uiRoot, `.${pathname}`);
  const relative = path.relative(uiRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function contentType(filePath) {
  if (/\.html$/i.test(filePath)) return "text/html; charset=utf-8";
  if (/\.css$/i.test(filePath)) return "text/css; charset=utf-8";
  if (/\.js$/i.test(filePath)) return "text/javascript; charset=utf-8";
  if (/\.json$/i.test(filePath)) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
