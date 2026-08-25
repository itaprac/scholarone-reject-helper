import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatBytes, pruneLogs, RETENTION_DEFAULTS } from "../src/core/log-retention.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [flag, value = "true"] = arg.replace(/^--/, "").split("=");
    return [flag, value];
  })
);

if (args.help) {
  console.log(`Czyszczenie logów przebiegów i zrzutów ekranu.

  --keep-runs=N        ile ostatnich logów przebiegu zostawić (domyślnie ${RETENTION_DEFAULTS.keepRuns})
  --keep-screenshots=N ile ostatnich katalogów ze zrzutami zostawić (domyślnie ${RETENTION_DEFAULTS.keepScreenshotRuns})
  --max-age-days=N     jak długo żyje ogon poza tą podłogą (domyślnie ${RETENTION_DEFAULTS.maxAgeDays}, 0 wyłącza)
  --include-reports    czyść także logs/reports (uwaga: reject-from-report ich potrzebuje)
  --include-screening  czyść także logs/screening i logs/eic-assessment
  --dry-run            pokaż, co zniknie, bez kasowania`);
  process.exit(0);
}

const result = await pruneLogs({
  logsDir: path.join(projectRoot, "logs"),
  keepRuns: toInteger(args["keep-runs"], RETENTION_DEFAULTS.keepRuns),
  keepScreenshotRuns: toInteger(args["keep-screenshots"], RETENTION_DEFAULTS.keepScreenshotRuns),
  maxAgeDays: toInteger(args["max-age-days"], RETENTION_DEFAULTS.maxAgeDays),
  includeReports: args["include-reports"] === "true",
  includeScreening: args["include-screening"] === "true",
  dryRun: args["dry-run"] === "true",
});

const verb = result.dryRun ? "Do usunięcia" : "Usunięto";
console.log(`${verb}: ${result.removed.length} pozycji, ${formatBytes(result.freedBytes)}`);
for (const absolutePath of result.removed) {
  console.log(`  ${path.relative(projectRoot, absolutePath)}`);
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
