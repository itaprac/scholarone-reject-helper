import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REJECT_MESSAGE } from "./default-message.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const uiRoot = path.join(projectRoot, "ui");
const reportsDir = path.join(projectRoot, "logs", "reports");
const autoRejectScript = path.join(projectRoot, "src", "auto-reject.js");
const settingsPath = path.join(projectRoot, "ui-settings.json");
const port = Number.parseInt(process.env.UI_PORT || "3131", 10);
const envDefaults = loadEnvFile(path.join(projectRoot, ".env"));

const jobs = new Map();
let activeJobId = null;
let nextJobId = 1;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

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
      const args = [
        "--headed",
        "--dry-run",
        ...optionArgs(body, {
          "start-url": "startUrl",
          "max-checked": "maxChecked",
          "submitted-older-than-days": "submittedOlderThanDays",
          "queue-start-page": "queueStartPage",
          "slow-mo": "slowMo",
        }),
        ...(body.keepOpen ? ["--keep-open"] : []),
      ];
      return sendJson(res, { job: startJob("dryrun", args) });
    }

    if (url.pathname === "/api/run/live" && req.method === "POST") {
      const body = await readJsonBody(req);
      const args = [
        "--headed",
        "--save-and-send",
        ...optionArgs(body, {
          "start-url": "startUrl",
          "max-checked": "maxChecked",
          "submitted-older-than-days": "submittedOlderThanDays",
          "queue-start-page": "queueStartPage",
          "max-rejected": "maxRejected",
          "slow-mo": "slowMo",
          "reject-message": "rejectMessage",
        }),
        ...(body.keepOpen ? ["--keep-open"] : []),
      ];
      return sendJson(res, { job: startJob("live-reject", args) });
    }

    if (url.pathname === "/api/run/send-from-report" && req.method === "POST") {
      const body = await readJsonBody(req);
      const reportPath = resolveReportPath(body.report);
      const args = [
        "--headed",
        "--save-and-send",
        "--require-targets",
        `--reject-from-report=${relativeProjectPath(reportPath)}`,
        ...optionArgs(body, {
          "start-url": "startUrl",
          "submitted-older-than-days": "submittedOlderThanDays",
          "max-rejected": "maxRejected",
          "slow-mo": "slowMo",
          "reject-message": "rejectMessage",
        }),
        ...(body.keepOpen ? ["--keep-open"] : []),
      ];
      return sendJson(res, { job: startJob("reject-from-report", args) });
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

server.listen(port, () => {
  console.log(`ScholarOne helper UI: http://localhost:${port}`);
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
    startUrl: saved.startUrl ?? envValue("START_URL", "https://mc.manuscriptcentral.com/kes"),
    maxChecked: saved.maxChecked ?? envValue("MAX_CHECKED", "50"),
    submittedOlderThanDays: saved.submittedOlderThanDays ?? envValue("SUBMITTED_OLDER_THAN_DAYS", "30"),
    queueStartPage: saved.queueStartPage ?? envValue("QUEUE_START_PAGE", ""),
    slowMo: saved.slowMo ?? envValue("SLOW_MO", "500"),
    maxRejected: saved.maxRejected ?? envValue("MAX_REJECTED", ""),
    keepOpen: saved.keepOpen ?? parseBool(envValue("KEEP_OPEN", ""), false),
    rejectMessage: saved.rejectMessage ?? loadRejectMessage(),
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
  };

  if (!settings.startUrl) {
    settings.startUrl = "https://mc.manuscriptcentral.com/kes";
  }
  if (!settings.rejectMessage) {
    settings.rejectMessage = loadRejectMessage();
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

function startJob(type, args) {
  const running = activeJobId ? jobs.get(activeJobId) : null;
  if (running && ["running", "stopping"].includes(running.status)) {
    const error = new Error(`Job ${activeJobId} is still running.`);
    error.statusCode = 409;
    throw error;
  }

  const id = String(nextJobId++);
  const child = spawn(process.execPath, [autoRejectScript, ...args], {
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

function optionArgs(body, mapping) {
  const args = [];
  for (const [flag, key] of Object.entries(mapping)) {
    const value = body[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    args.push(`--${flag}=${value}`);
  }
  return args;
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
