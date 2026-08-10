import fsp from "node:fs/promises";
import path from "node:path";

export const RETENTION_DEFAULTS = Object.freeze({
  keepRuns: 15,
  maxAgeDays: 30,
  // Zrzuty ekranu bywają o dwa rzędy wielkości cięższe niż log tekstowy tego
  // samego przebiegu, więc mają własny, ciaśniejszy próg i nie podlegają
  // limitowi wieku — inaczej katalog rośnie szybciej, niż zdąży się zestarzeć.
  keepScreenshotRuns: 5,
});

// Raporty i wyniki screeningu są danymi, nie logami — reject-from-report czyta je
// tygodniami po przebiegu. Czyszczone są wyłącznie na jawne żądanie.
const RUN_LOG_PATTERN = /^(select-reviewers-)?\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/;

export async function pruneLogs({
  logsDir,
  keepRuns = RETENTION_DEFAULTS.keepRuns,
  keepScreenshotRuns = RETENTION_DEFAULTS.keepScreenshotRuns,
  maxAgeDays = RETENTION_DEFAULTS.maxAgeDays,
  includeReports = false,
  includeScreening = false,
  dryRun = false,
} = {}) {
  if (!logsDir) {
    throw new Error("pruneLogs wymaga ścieżki logsDir.");
  }

  const cutoff = Number.isFinite(maxAgeDays) && maxAgeDays > 0
    ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    : null;

  const targets = [
    ...(await collectRunLogs(logsDir, keepRuns, cutoff)),
    ...(await collectScreenshotDirs(logsDir, keepScreenshotRuns, null)),
    ...(await collectStrayFiles(logsDir)),
  ];

  if (includeReports) {
    targets.push(...(await collectDated(path.join(logsDir, "reports"), keepRuns, cutoff)));
  }
  if (includeScreening) {
    targets.push(...(await collectDated(path.join(logsDir, "screening"), keepRuns, cutoff)));
  }

  let freedBytes = 0;
  const removed = [];

  for (const target of targets) {
    freedBytes += target.bytes;
    removed.push(target.absolutePath);
    if (!dryRun) {
      await fsp.rm(target.absolutePath, { recursive: true, force: true });
    }
  }

  return { removed, freedBytes, dryRun };
}

async function collectRunLogs(logsDir, keepRuns, cutoff) {
  const entries = await readDir(logsDir);
  const logs = [];

  for (const entry of entries) {
    if (!entry.isFile() || !RUN_LOG_PATTERN.test(entry.name)) continue;
    const absolutePath = path.join(logsDir, entry.name);
    logs.push(await describe(absolutePath));
  }

  return selectExpired(logs, keepRuns, cutoff);
}

async function collectScreenshotDirs(logsDir, keepRuns, cutoff) {
  const screenshotsDir = path.join(logsDir, "screenshots");
  const entries = await readDir(screenshotsDir);
  const dirs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const absolutePath = path.join(screenshotsDir, entry.name);
    dirs.push(await describe(absolutePath));
  }

  return selectExpired(dirs, keepRuns, cutoff);
}

// Zrzuty robione ręcznie przy testowaniu UI, zapisane wprost w logs/.
async function collectStrayFiles(logsDir) {
  const entries = await readDir(logsDir);
  const stray = [];

  for (const entry of entries) {
    if (!entry.isFile() || !/^ui-screenshot.*\.png$/i.test(entry.name)) continue;
    stray.push(await describe(path.join(logsDir, entry.name)));
  }

  return stray;
}

async function collectDated(directory, keepRuns, cutoff) {
  const entries = await readDir(directory);
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files.push(await describe(path.join(directory, entry.name)));
  }

  return selectExpired(files, keepRuns, cutoff);
}

// Dwa niezależne progi:
//   keepRuns   — twarda podłoga. Najnowsze N pozycji nie znika nigdy, także gdy
//                są starsze niż limit wieku.
//   maxAgeDays — jak długo żyje ogon poza tą podłogą. Zero wyłącza limit wieku,
//                czyli zostaje dokładnie N ostatnich przebiegów.
function selectExpired(entries, keepRuns, cutoff) {
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const protectedCount = Math.max(0, keepRuns);

  return sorted.filter((entry, index) => {
    if (index < protectedCount) return false;
    if (cutoff === null) return true;
    return entry.mtimeMs < cutoff;
  });
}

async function describe(absolutePath) {
  const stat = await fsp.stat(absolutePath);
  const bytes = stat.isDirectory() ? await directorySize(absolutePath) : stat.size;
  return { absolutePath, mtimeMs: stat.mtimeMs, bytes };
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await readDir(directory)) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(absolutePath);
      continue;
    }
    const stat = await fsp.stat(absolutePath).catch(() => null);
    total += stat?.size || 0;
  }
  return total;
}

async function readDir(directory) {
  return fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
