import {
  ASSESSMENT_REASONING_EFFORTS,
  DEFAULT_ASSESSMENT_REASONING_EFFORT,
} from "../assessment-config.js";
import { REVIEWER_QUEUES, UI_DEFAULTS } from "./defaults.js";

// Jedyne źródło prawdy o opcjach uruchomienia.
//
// Wcześniej dodanie jednej opcji wymagało edycji siedmiu miejsc: mapowania w
// job-args.js, walidacji w run-options.js, publicConfig() i saveUiSettings() w
// ui-server.js, obiektu config, pola w index.html i wpisu w els w app.js.
// Rozjazd między nimi był kwestią czasu, bo nic go nie pilnowało.
//
// Teraz każda opcja jest opisana raz, a parser CLI, walidator, budowanie
// argumentów zadania, ustawienia UI i formularze biorą się z tego opisu.
//
//   key   — klucz w ciele żądania UI i w zapisanych ustawieniach
//   flag  — flaga CLI (bez --); ta sama flaga może mieć różne klucze w różnych
//           trybach, np. start-url to startUrl, reviewerStartUrl i screeningStartUrl
//   env   — zmienna w .env
//   type  — url | int | text | choice | bool
//   min   — dolna granica dla int; brak oznacza brak ograniczenia
export const FIELDS = Object.freeze({
  startUrl: {
    flag: "start-url", env: "START_URL", type: "url",
    default: UI_DEFAULTS.startUrl, label: "Start URL",
    help: "Adres startowy ScholarOne.",
  },
  maxChecked: {
    flag: "max-checked", env: "MAX_CHECKED", type: "int", min: 1,
    default: String(UI_DEFAULTS.maxChecked), label: "Max checked",
    help: "Ile manuskryptów sprawdzić w tym przebiegu.",
  },
  submittedOlderThanDays: {
    flag: "submitted-older-than-days", env: "SUBMITTED_OLDER_THAN_DAYS", type: "int", min: 1,
    default: String(UI_DEFAULTS.submittedOlderThanDays), label: "Older than (days)",
    help: "Próg wieku zgłoszenia.",
  },
  queueStartPage: {
    flag: "queue-start-page", env: "QUEUE_START_PAGE", type: "int", min: 1,
    default: "", optional: true, label: "Queue start page",
    help: "Start od danej strony listy, np. 2 to pozycje 11-20.",
  },
  slowMo: {
    flag: "slow-mo", env: "SLOW_MO", type: "int", min: 0,
    default: String(UI_DEFAULTS.slowMo), label: "Slow motion (ms)",
    help: "Spowolnienie kliknięć Playwrighta.",
  },
  maxRejected: {
    flag: "max-rejected", env: "MAX_REJECTED", type: "int", min: 1,
    default: "", optional: true, label: "Max rejected",
    help: "Bezpiecznik: maksymalna liczba odrzuceń w przebiegu.",
  },
  rejectMessage: {
    flag: "reject-message", env: "REJECT_MESSAGE", type: "text",
    label: "Rejection email", multiline: true,
  },
  keepOpen: {
    flag: "keep-open", env: "KEEP_OPEN", type: "bool",
    default: false, label: "Keep browser open",
  },

  reviewerStartUrl: {
    flag: "start-url", env: "START_URL", type: "url",
    default: UI_DEFAULTS.startUrl, label: "Start URL",
  },
  reviewerQueue: {
    flag: "reviewer-queue", type: "choice", choices: REVIEWER_QUEUES,
    default: UI_DEFAULTS.reviewerQueue, label: "Queue",
    help: "Combined kończy najpierw artykuły czekające w Invite Reviewers.",
  },
  reviewersPerPaper: {
    flag: "reviewers-per-paper", env: "REVIEWERS_PER_PAPER", type: "int", min: 1,
    default: String(UI_DEFAULTS.reviewersPerPaper), label: "Reviewers per paper",
  },
  reviewerMaxManuscripts: {
    flag: "max-manuscripts", type: "int", min: 1,
    default: String(UI_DEFAULTS.reviewerMaxManuscripts), label: "Max manuscripts",
  },
  reviewerSlowMo: {
    flag: "slow-mo", env: "SLOW_MO", type: "int", min: 0,
    default: String(UI_DEFAULTS.slowMo), label: "Slow motion (ms)",
  },
  reviewerRefreshWaitSeconds: {
    flag: "refresh-wait-seconds", env: "REVIEWER_REFRESH_WAIT_SECONDS", type: "int", min: 1,
    default: String(UI_DEFAULTS.reviewerRefreshWaitSeconds), label: "Refresh wait (s)",
    help: "Przerwa przed powrotem do artykułu odłożonego po Refresh Search.",
  },
  reviewerKeepOpen: {
    flag: "keep-open", type: "bool", default: false, label: "Keep browser open",
  },

  screeningStartUrl: {
    flag: "start-url", env: "START_URL", type: "url",
    default: UI_DEFAULTS.startUrl, label: "Start URL",
  },
  screeningMaxChecked: {
    flag: "max-checked", type: "int", min: 1,
    default: String(UI_DEFAULTS.screeningMaxChecked), label: "Max checked",
  },
  screeningSlowMo: {
    flag: "slow-mo", env: "SLOW_MO", type: "int", min: 0,
    default: String(UI_DEFAULTS.slowMo), label: "Slow motion (ms)",
  },
  assessmentModel: {
    flag: "assessment-model", env: "ASSESSMENT_MODEL", type: "text",
    default: UI_DEFAULTS.assessmentModel, label: "Model",
  },
  assessmentReasoningEffort: {
    flag: "assessment-reasoning-effort", env: "ASSESSMENT_REASONING_EFFORT",
    type: "choice", choices: ASSESSMENT_REASONING_EFFORTS,
    default: DEFAULT_ASSESSMENT_REASONING_EFFORT, label: "Reasoning effort",
  },
  assessmentTimeoutSeconds: {
    flag: "assessment-timeout-seconds", env: "ASSESSMENT_TIMEOUT_SECONDS", type: "int", min: 10,
    default: String(UI_DEFAULTS.assessmentTimeoutSeconds), label: "Timeout (s)",
  },
  assessmentPrompt: {
    flag: "assessment-prompt", env: "ASSESSMENT_PROMPT", type: "text",
    required: true, label: "Assessment prompt", multiline: true,
  },
  screeningRejectMessage: {
    flag: "screening-reject-message", env: "SCREENING_REJECT_MESSAGE", type: "text",
    label: "Live rejection email", multiline: true,
  },
  screeningScanAll: {
    flag: "scan-all-metadata", type: "bool", default: true, label: "Entire queue",
  },
  // Tylko przebiegi wykonujące decyzje (live i from-run) — dlatego flaga nie
  // wchodzi do pól trybu screening, a job-args dokleja ją warunkowo, tak jak
  // screeningRejectMessage.
  screeningApproveWithoutAssign: {
    flag: "approve-without-assign", type: "bool",
    default: false, label: "Approve without assigning editors",
    help: "APPROVE tylko klika Approve; artykuł czeka w Awaiting EIC Assignment na ręczne dobranie edytorów po przejrzeniu PDF.",
  },
  screeningKeepOpen: {
    flag: "keep-open", type: "bool", default: false, label: "Keep browser open",
  },
});

// Kolejność pól wyznacza kolejność argumentów CLI. Testy przybijają ją wprost,
// bo zmiana kolejności to zmiana komendy, którą użytkownik widzi w logu.
export const RUN_MODES = Object.freeze({
  dryrun: {
    entry: "reject",
    flags: ["--headed", "--dry-run"],
    fields: ["startUrl", "maxChecked", "submittedOlderThanDays", "queueStartPage", "slowMo"],
    trailing: ["keepOpen"],
  },
  live: {
    entry: "reject",
    flags: ["--headed", "--save-and-send"],
    fields: [
      "startUrl", "maxChecked", "submittedOlderThanDays", "queueStartPage",
      "maxRejected", "slowMo", "rejectMessage",
    ],
    trailing: ["keepOpen"],
  },
  "send-from-report": {
    entry: "reject",
    flags: ["--headed", "--save-and-send"],
    requiresReport: true,
    fields: ["startUrl", "submittedOlderThanDays", "maxRejected", "slowMo", "rejectMessage"],
    trailing: ["keepOpen"],
  },
  "reviewers-prepare": {
    entry: "reviewers",
    flags: ["--select-reviewers", "--headed"],
    fields: [
      "reviewerStartUrl", "reviewersPerPaper", "reviewerMaxManuscripts",
      "reviewerSlowMo", "reviewerRefreshWaitSeconds",
    ],
    trailing: ["reviewerKeepOpen"],
    singleManuscript: true,
  },
  "reviewers-invite": {
    entry: "reviewers",
    flags: ["--select-reviewers", "--headed"],
    fields: [
      "reviewerStartUrl", "reviewersPerPaper", "reviewerMaxManuscripts",
      "reviewerSlowMo", "reviewerRefreshWaitSeconds",
    ],
    trailing: ["reviewerKeepOpen"],
    live: true,
  },
  screening: {
    entry: "reject",
    flags: ["--headed", "--collect-metadata", "--assess-with-llm"],
    fields: [
      "screeningStartUrl", "screeningMaxChecked", "screeningSlowMo",
      "assessmentModel", "assessmentReasoningEffort", "assessmentTimeoutSeconds",
      "assessmentPrompt",
    ],
    trailing: ["screeningKeepOpen"],
  },
});

export function field(key) {
  const definition = FIELDS[key];
  if (!definition) throw new Error(`Nieznana opcja: ${key}`);
  return definition;
}

export function modeDefinition(mode) {
  const definition = RUN_MODES[mode];
  if (!definition) {
    const error = new Error(`Nieznany tryb uruchomienia: ${mode}`);
    error.statusCode = 400;
    throw error;
  }
  return definition;
}

// Wszystkie klucze, które UI zapisuje w ui-settings.json.
export function settingsKeys() {
  return Object.keys(FIELDS);
}

// Opis pól dla formularzy UI, pogrupowany po trybie.
export function describeFields(mode) {
  const definition = modeDefinition(mode);
  return [...definition.fields, ...(definition.trailing || [])].map((key) => ({
    key,
    ...field(key),
  }));
}
