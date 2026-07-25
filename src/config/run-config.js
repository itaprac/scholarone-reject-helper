import path from "node:path";
import { DEFAULT_REJECT_MESSAGE } from "../default-message.js";
import { DEFAULT_SCREENING_REJECT_MESSAGE } from "../default-screening-reject-message.js";
import { DEFAULT_ASSESSMENT_PROMPT } from "../default-assessment-prompt.js";
import {
  DEFAULT_ASSESSMENT_MODEL,
  DEFAULT_ASSESSMENT_REASONING_EFFORT,
} from "../assessment-config.js";
import { DEFAULT_EDITOR_NAME } from "../screening-approval.js";
import { normalizeManuscriptId } from "../manuscript-rules.js";
import {
  loadEnvFile,
  loadLoginCredentials,
  loadTextOption,
  parseArgs,
  parseBool,
  toInteger,
  toOptionalPositiveInteger,
} from "../core/env.js";
import { DEFAULTS, projectRoot } from "./defaults.js";

// Zbudowanie konfiguracji przebiegu z argumentów CLI i pliku .env. Wydzielone z
// auto-reject.js, żeby dało się je wywołać w teście bez uruchamiania automatu.
export function buildRunConfig(rawArgs = process.argv.slice(2), {
  envFile = path.join(projectRoot, ".env"),
} = {}) {
  const args = parseArgs(rawArgs);
  const env = loadEnvFile(envFile);
  const credentials = loadLoginCredentials(args, env);

  const config = {
    startUrl: args["start-url"] || env.START_URL || DEFAULTS.startUrl,
    maxChecked: toInteger(args["max-checked"] || env.MAX_CHECKED, DEFAULTS.maxChecked),
    submittedOlderThanDays: toInteger(
      args["submitted-older-than-days"] || env.SUBMITTED_OLDER_THAN_DAYS,
      DEFAULTS.submittedOlderThanDays
    ),
    headless: parseBool(args.headless ?? env.HEADLESS, DEFAULTS.headless),
    headed: args.headed === true,
    browserChannel: args["browser-channel"] || env.BROWSER_CHANNEL || "",
    cdp: args.cdp || env.CDP || "",
    slowMo: toInteger(args["slow-mo"] || env.SLOW_MO, DEFAULTS.slowMo),
    stopAfterQueue: args["stop-after-queue"] === true,
    dryRun: parseBool(args["dry-run"] ?? env.DRY_RUN, false),
    reportOnly: parseBool(args["report-only"] ?? env.REPORT_ONLY, false),
    clickReject: parseBool(args["click-reject"] ?? env.CLICK_REJECT, false),
    saveAndSend: parseBool(args["save-and-send"] ?? env.SAVE_AND_SEND, false),
    maxRejected: toOptionalPositiveInteger(args["max-rejected"] || env.MAX_REJECTED),
    // Wspólny bezpiecznik operacji nieodwracalnych dla trybów, które dotąd nie
    // miały odpowiednika --max-rejected: screeningu live i zaproszeń.
    maxLiveActions: toOptionalPositiveInteger(args["max-live-actions"] || env.MAX_LIVE_ACTIONS)
      ?? DEFAULTS.maxLiveActions,
    keepOpen: parseBool(args["keep-open"] ?? env.KEEP_OPEN, false),
    debugScreenshots: parseBool(args["debug-screenshots"] ?? env.DEBUG_SCREENSHOTS, DEFAULTS.debugScreenshots),
    autoLogin: parseBool(
      args["auto-login"] ?? env.AUTO_LOGIN,
      Boolean(credentials.username && credentials.password)
    ),
    loginUsername: credentials.username,
    loginPassword: credentials.password,
    queueStartPage: toInteger(args["queue-start-page"] || env.QUEUE_START_PAGE, DEFAULTS.queueStartPage),
    rejectFromReport: args["reject-from-report"] || env.REJECT_FROM_REPORT || "",
    rejectIds: parseIdList(args["reject-ids"] || env.REJECT_IDS || ""),
    rejectProgressFile: args["reject-progress-file"] || env.REJECT_PROGRESS_FILE || "",
    requireTargets: parseBool(args["require-targets"] ?? env.REQUIRE_TARGETS, false),
    collectMetadata: args["collect-metadata"] === true,
    scanAllMetadata: parseBool(args["scan-all-metadata"] ?? env.SCAN_ALL_METADATA, false),
    assessWithLlm: args["assess-with-llm"] === true,
    applyAssessmentDecisions: args["apply-assessment-decisions"] === true,
    assessmentModel: args["assessment-model"] || env.ASSESSMENT_MODEL || DEFAULT_ASSESSMENT_MODEL,
    assessmentReasoningEffort:
      args["assessment-reasoning-effort"] ||
      env.ASSESSMENT_REASONING_EFFORT ||
      DEFAULT_ASSESSMENT_REASONING_EFFORT,
    assessmentTimeoutSeconds: toInteger(
      args["assessment-timeout-seconds"] || env.ASSESSMENT_TIMEOUT_SECONDS,
      DEFAULTS.assessmentTimeoutSeconds
    ),
    // Ile ocen naraz w dry-runie. W trybie live i tak schodzi do jednej, bo
    // decyzja musi poprzedzać kliknięcie.
    assessmentConcurrency: toInteger(
      args["assessment-concurrency"] || env.ASSESSMENT_CONCURRENCY,
      DEFAULTS.assessmentConcurrency
    ),
    assessmentCache: parseBool(args["assessment-cache"] ?? env.ASSESSMENT_CACHE, true) &&
      args["no-cache"] !== true,
    assessmentPrompt: loadTextOption(args, env, {
      fileArg: "assessment-prompt-file",
      fileEnv: "ASSESSMENT_PROMPT_FILE",
      inlineArg: "assessment-prompt",
      inlineEnv: "ASSESSMENT_PROMPT",
      fallback: DEFAULT_ASSESSMENT_PROMPT,
      trim: "both",
    }),
    screeningEditorName: args["screening-editor-name"] || DEFAULT_EDITOR_NAME,
    screeningRejectMessage: loadTextOption(args, env, {
      fileArg: "screening-reject-message-file",
      fileEnv: "SCREENING_REJECT_MESSAGE_FILE",
      inlineArg: "screening-reject-message",
      inlineEnv: "SCREENING_REJECT_MESSAGE",
      fallback: DEFAULT_SCREENING_REJECT_MESSAGE,
    }),
    rejectMessage: loadTextOption(args, env, {
      fileArg: "reject-message-file",
      fileEnv: "REJECT_MESSAGE_FILE",
      inlineArg: "reject-message",
      inlineEnv: "REJECT_MESSAGE",
      fallback: DEFAULT_REJECT_MESSAGE,
    }),
    profileDir: args["profile-dir"] || DEFAULTS.profileDir,
    logsDir: args["logs-dir"] || DEFAULTS.logsDir,
  };

  return applyModeRules(config);
}

// Flagi trybu nie są niezależne: część z nich wyłącza inne. Trzymamy te
// zależności w jednym miejscu, żeby żadna ścieżka nie mogła ich pominąć.
export function applyModeRules(config) {
  if (config.headed) config.headless = false;
  if (config.saveAndSend) config.clickReject = true;
  if (config.dryRun) config.reportOnly = true;

  // reportOnly jest nadrzędny: raportowanie nigdy nie wysyła maili.
  if (config.reportOnly) {
    config.clickReject = false;
    config.saveAndSend = false;
  }

  if (config.applyAssessmentDecisions && (!config.collectMetadata || !config.assessWithLlm)) {
    throw new Error("--apply-assessment-decisions wymaga --collect-metadata i --assess-with-llm.");
  }

  return config;
}

export function parseIdList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeManuscriptId);
}
