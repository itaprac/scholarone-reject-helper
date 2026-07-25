import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REJECT_MESSAGE } from "./default-message.js";
import { DEFAULT_ASSESSMENT_PROMPT } from "./default-assessment-prompt.js";
import { DEFAULT_SCREENING_REJECT_MESSAGE } from "./default-screening-reject-message.js";
import {
  DEFAULT_ASSESSMENT_MODEL,
  DEFAULT_ASSESSMENT_REASONING_EFFORT,
  normalizeAssessmentReasoningEffort,
} from "./assessment-config.js";
import { buildJobArgs, buildReviewerJobArgs, buildScreeningJobArgs } from "./job-args.js";
import { validateRunOptions } from "./run-options.js";
import { REVIEWER_QUEUES, UI_DEFAULTS } from "./config/defaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const uiRoot = path.join(projectRoot, "ui");
const reportsDir = path.join(projectRoot, "logs", "reports");
const autoRejectScript = path.join(projectRoot, "src", "auto-reject.js");
const scholarOneScript = path.join(projectRoot, "src", "scholarone.js");
const settingsPath = path.join(projectRoot, "ui-settings.json");
const preferredPort = Number.parseInt(process.env.UI_PORT || "3131", 10);
const maxPort = preferredPort + 20;
const listenHost = "127.0.0.1";
const envDefaults = loadEnvFile(path.join(projectRoot, ".env"));

const jobs = new Map();
let activeJobId = null;
let nextJobId = 1;

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

    if (url.pathname === "/api/run/reviewers/prepare" && req.method === "POST") {
      const body = await readJsonBody(req);
      validateRunOptions(body, "reviewers-prepare");
      const args = buildReviewerJobArgs("reviewers-prepare", body);
      return sendJson(res, { job: startJob("reviewers-prepare", args, scholarOneScript) });
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

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === "GET") {
      const job = jobs.get(jobMatch[1]);
      return sendJson(res, { job: publicJob(job) });
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

async function publicConfig() {
  const saved = await readJsonFile(settingsPath) || {};
  return {
    settingsPath: relativeProjectPath(settingsPath),
    settingsSaved: fs.existsSync(settingsPath),
    startUrl: saved.startUrl ?? envValue("START_URL", UI_DEFAULTS.startUrl),
    maxChecked: saved.maxChecked ?? envValue("MAX_CHECKED", String(UI_DEFAULTS.maxChecked)),
    submittedOlderThanDays: saved.submittedOlderThanDays ?? envValue("SUBMITTED_OLDER_THAN_DAYS", String(UI_DEFAULTS.submittedOlderThanDays)),
    queueStartPage: saved.queueStartPage ?? envValue("QUEUE_START_PAGE", ""),
    slowMo: saved.slowMo ?? envValue("SLOW_MO", String(UI_DEFAULTS.slowMo)),
    maxRejected: saved.maxRejected ?? envValue("MAX_REJECTED", ""),
    keepOpen: saved.keepOpen ?? parseBool(envValue("KEEP_OPEN", ""), false),
    rejectMessage: saved.rejectMessage ?? loadRejectMessage(),
    reviewerStartUrl: saved.reviewerStartUrl ?? envValue("START_URL", UI_DEFAULTS.startUrl),
    reviewerQueue: REVIEWER_QUEUES.includes(saved.reviewerQueue)
      ? saved.reviewerQueue
      : UI_DEFAULTS.reviewerQueue,
    reviewersPerPaper: saved.reviewersPerPaper ?? envValue("REVIEWERS_PER_PAPER", String(UI_DEFAULTS.reviewersPerPaper)),
    reviewerMaxManuscripts: saved.reviewerMaxManuscripts ?? String(UI_DEFAULTS.reviewerMaxManuscripts),
    reviewerSlowMo: saved.reviewerSlowMo ?? envValue("SLOW_MO", String(UI_DEFAULTS.slowMo)),
    reviewerRefreshWaitSeconds: saved.reviewerRefreshWaitSeconds ?? envValue("REVIEWER_REFRESH_WAIT_SECONDS", String(UI_DEFAULTS.reviewerRefreshWaitSeconds)),
    reviewerKeepOpen: saved.reviewerKeepOpen ?? false,
    screeningStartUrl: saved.screeningStartUrl ?? envValue("START_URL", UI_DEFAULTS.startUrl),
    screeningMaxChecked: saved.screeningMaxChecked ?? String(UI_DEFAULTS.screeningMaxChecked),
    screeningScanAll: saved.screeningScanAll ?? true,
    screeningSlowMo: saved.screeningSlowMo ?? envValue("SLOW_MO", String(UI_DEFAULTS.slowMo)),
    screeningKeepOpen: false,
    assessmentModel: String(
      saved.assessmentModel ||
      envValue("ASSESSMENT_MODEL", DEFAULT_ASSESSMENT_MODEL) ||
      DEFAULT_ASSESSMENT_MODEL
    ).trim(),
    assessmentReasoningEffort: normalizeAssessmentReasoningEffort(
      saved.assessmentReasoningEffort ??
      envValue("ASSESSMENT_REASONING_EFFORT", DEFAULT_ASSESSMENT_REASONING_EFFORT)
    ),
    assessmentTimeoutSeconds: saved.assessmentTimeoutSeconds ?? envValue("ASSESSMENT_TIMEOUT_SECONDS", String(UI_DEFAULTS.assessmentTimeoutSeconds)),
    assessmentPrompt: saved.assessmentPrompt ?? envValue("ASSESSMENT_PROMPT", DEFAULT_ASSESSMENT_PROMPT).replace(/\\n/g, "\n"),
    screeningRejectMessage: saved.screeningRejectMessage ??
      envValue("SCREENING_REJECT_MESSAGE", DEFAULT_SCREENING_REJECT_MESSAGE).replace(/\\n/g, "\n"),
  };
}

async function saveUiSettings(body) {
  const settings = {
    startUrl: String(body.startUrl || "").trim(),
    maxChecked: normalizeIntegerSetting(body.maxChecked, "50"),
    submittedOlderThanDays: normalizeIntegerSetting(body.submittedOlderThanDays, "30"),
    queueStartPage: normalizeOptionalIntegerSetting(body.queueStartPage),
    slowMo: normalizeIntegerSetting(body.slowMo, "500", 0),
    maxRejected: normalizeOptionalIntegerSetting(body.maxRejected),
    keepOpen: Boolean(body.keepOpen),
    rejectMessage: String(body.rejectMessage || "").trimEnd(),
    reviewerStartUrl: String(body.reviewerStartUrl || "").trim(),
    reviewerQueue: REVIEWER_QUEUES.includes(body.reviewerQueue)
      ? body.reviewerQueue
      : UI_DEFAULTS.reviewerQueue,
    reviewersPerPaper: normalizeIntegerSetting(body.reviewersPerPaper, "10"),
    reviewerMaxManuscripts: normalizeIntegerSetting(body.reviewerMaxManuscripts, "3"),
    reviewerSlowMo: normalizeIntegerSetting(body.reviewerSlowMo, "500", 0),
    reviewerRefreshWaitSeconds: normalizeIntegerSetting(body.reviewerRefreshWaitSeconds, "60"),
    reviewerKeepOpen: Boolean(body.reviewerKeepOpen),
    screeningStartUrl: String(body.screeningStartUrl || "").trim(),
    screeningMaxChecked: normalizeIntegerSetting(body.screeningMaxChecked, "10"),
    screeningScanAll: Boolean(body.screeningScanAll),
    screeningSlowMo: normalizeIntegerSetting(body.screeningSlowMo, "500", 0),
    screeningKeepOpen: Boolean(body.screeningKeepOpen),
    assessmentModel: String(body.assessmentModel || DEFAULT_ASSESSMENT_MODEL).trim(),
    assessmentReasoningEffort: normalizeAssessmentReasoningEffort(
      body.assessmentReasoningEffort
    ),
    assessmentTimeoutSeconds: normalizeIntegerSetting(body.assessmentTimeoutSeconds, "120", 10),
    assessmentPrompt: String(body.assessmentPrompt || "").trim(),
    screeningRejectMessage: String(body.screeningRejectMessage || "").trimEnd(),
  };

  if (!settings.startUrl) {
    settings.startUrl = UI_DEFAULTS.startUrl;
  }
  if (!settings.rejectMessage) {
    settings.rejectMessage = loadRejectMessage();
  }
  if (!settings.reviewerStartUrl) {
    settings.reviewerStartUrl = settings.startUrl;
  }
  if (!settings.screeningStartUrl) {
    settings.screeningStartUrl = settings.startUrl;
  }
  if (!settings.assessmentPrompt) {
    settings.assessmentPrompt = DEFAULT_ASSESSMENT_PROMPT;
  }
  if (!settings.screeningRejectMessage) {
    settings.screeningRejectMessage = DEFAULT_SCREENING_REJECT_MESSAGE;
  }

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
    child,
  };

  jobs.set(id, job);
  activeJobId = id;

  const append = (chunk) => {
    job.output += chunk.toString();
    if (job.output.length > 120_000) {
      job.output = job.output.slice(-120_000);
    }
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("close", (code) => {
    job.status = job.status === "stopping" ? "stopped" : code === 0 ? "finished" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    job.child = null;
    if (activeJobId === id) {
      activeJobId = null;
    }
  });

  return publicJob(job);
}

function publicJob(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    type: job.type,
    args: job.args,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    output: job.output,
  };
}

function normalizeIntegerSetting(value, fallback, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    return fallback;
  }
  return String(parsed);
}

function normalizeOptionalIntegerSetting(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return "";
  }
  return String(parsed);
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

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
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
  if (pathname === "/") {
    pathname = "/index.html";
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
