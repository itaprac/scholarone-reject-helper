import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { loadEnvFile, loadLoginCredentials, parseArgs } from "./core/env.js";
import { DEFAULTS, projectRoot } from "./config/defaults.js";

const run = promisify(execFile);

// Sprawdzenie środowiska przed uruchomieniem. Bez tego o wylogowanym Codeksie
// albo braku Chromium dowiadujesz się dopiero w połowie przebiegu, po
// zalogowaniu do ScholarOne i przejściu kilku manuskryptów.
export async function runDoctorChecks() {
  return Promise.all([
    checkNode(),
    checkChromium(),
    checkCodex(),
    checkCredentials(),
    checkLogsWritable(),
  ]);
}

function ok(name, detail) {
  return { name, status: "ok", detail };
}
function warn(name, detail, hint) {
  return { name, status: "warn", detail, hint };
}
function fail(name, detail, hint) {
  return { name, status: "fail", detail, hint };
}

async function checkNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  return major >= 20
    ? ok("Node.js", `v${process.versions.node}`)
    : fail("Node.js", `v${process.versions.node}`, "Wymagany Node 20 lub nowszy.");
}

async function checkChromium() {
  try {
    const { chromium } = await import("playwright");
    const executable = chromium.executablePath();
    return fs.existsSync(executable)
      ? ok("Chromium", path.basename(executable))
      : fail("Chromium", "brak pobranej przeglądarki", "Uruchom: npm run install-browsers");
  } catch (error) {
    return fail("Chromium", error.message, "Uruchom: npm install && npm run install-browsers");
  }
}

async function checkCodex() {
  const executable = process.env.CODEX_CLI || "codex";
  try {
    const { stdout } = await run(executable, ["login", "status"], { timeout: 15_000 });
    const output = stdout.trim();
    return /not logged in|logged out/i.test(output)
      ? warn("Codex CLI", output.slice(0, 120), "Zaloguj się: codex login")
      : ok("Codex CLI", output.slice(0, 120) || "zalogowany");
  } catch (error) {
    // Codex jest potrzebny tylko do wstępnej oceny LLM — odrzucanie i wybór
    // recenzentów działają bez niego.
    return warn(
      "Codex CLI",
      error.code === "ENOENT" ? "nie znaleziono w PATH" : error.message.slice(0, 120),
      "Potrzebny tylko do trybu Initial assessment."
    );
  }
}

async function checkCredentials() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnvFile(path.join(projectRoot, ".env"));
  const { username, password } = loadLoginCredentials(args, env);

  if (username && password) return ok("Dane logowania", `login ${maskLogin(username)}`);
  return warn(
    "Dane logowania",
    "brak AUTO_LOGIN w .env",
    "Bez nich trzeba zalogować się ręcznie w oknie przeglądarki."
  );
}

async function checkLogsWritable() {
  try {
    await fsp.mkdir(DEFAULTS.logsDir, { recursive: true });
    const probe = path.join(DEFAULTS.logsDir, ".doctor-probe");
    await fsp.writeFile(probe, "ok", "utf8");
    await fsp.rm(probe, { force: true });
    return ok("Katalog logów", relative(DEFAULTS.logsDir));
  } catch (error) {
    return fail("Katalog logów", error.message, `Sprawdź uprawnienia do ${DEFAULTS.logsDir}`);
  }
}

function maskLogin(value) {
  const text = String(value);
  return text.length <= 3 ? "***" : `${text.slice(0, 2)}***${text.slice(-1)}`;
}

function relative(target) {
  return path.relative(projectRoot, target) || ".";
}

export function formatDoctorReport(checks) {
  const symbols = { ok: "OK  ", warn: "UWAGA", fail: "BŁĄD" };
  const lines = checks.map((check) => {
    const head = `${symbols[check.status]} ${check.name}: ${check.detail}`;
    return check.hint ? `${head}\n      → ${check.hint}` : head;
  });

  const failed = checks.filter((check) => check.status === "fail").length;
  lines.push("", failed ? `${failed} problem(y) do naprawy przed uruchomieniem.` : "Środowisko gotowe.");
  return lines.join("\n");
}
