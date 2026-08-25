import {
  DEFAULT_ASSESSMENT_PROMPT,
  DEFAULT_EIC_ASSESSMENT_PROMPT,
} from "../default-assessment-prompt.js";
import { DEFAULT_SCREENING_REJECT_MESSAGE } from "../default-screening-reject-message.js";
import { normalizeAssessmentReasoningEffort } from "../assessment-config.js";
import { parseBool } from "../core/env.js";
import { FIELDS } from "./options.js";
import { UI_DEFAULTS } from "./defaults.js";

// Odczyt i zapis ustawień panelu, wyprowadzone z tej samej definicji opcji co
// argumenty CLI i walidacja. Wcześniej publicConfig() i saveUiSettings()
// wyliczały te same wartości osobno, każda własnym zestawem literałów.

// Pola, których wartość domyślna nie da się zapisać w tabeli, bo zależy od
// zawartości plików albo od innej opcji.
const DYNAMIC_DEFAULTS = {
  assessmentPrompt: () => DEFAULT_ASSESSMENT_PROMPT,
  eicAssessmentPrompt: () => DEFAULT_EIC_ASSESSMENT_PROMPT,
  screeningRejectMessage: () => DEFAULT_SCREENING_REJECT_MESSAGE,
  eicAssessmentRejectMessage: () => DEFAULT_SCREENING_REJECT_MESSAGE,
};

export function buildPublicConfig({ saved = {}, envValue, rejectMessage }) {
  const config = {};

  for (const [key, definition] of Object.entries(FIELDS)) {
    config[key] = readValue(key, definition, { saved, envValue });
  }

  // Wiadomość odrzucenia potrafi pochodzić z pliku wskazanego w .env.
  config.rejectMessage = saved.rejectMessage ?? rejectMessage();

  // Adresy startowe trybów dziedziczą po głównym, jeśli nie ustawiono własnego.
  config.reviewerStartUrl = saved.reviewerStartUrl ?? config.startUrl;
  config.screeningStartUrl = saved.screeningStartUrl ?? config.startUrl;
  config.eicAssessmentStartUrl = saved.eicAssessmentStartUrl ?? config.startUrl;

  return config;
}

export function normalizeUiSettings(body, { rejectMessage }) {
  const settings = {};

  for (const [key, definition] of Object.entries(FIELDS)) {
    settings[key] = normalizeValue(body[key], definition);
  }

  if (!settings.startUrl) settings.startUrl = UI_DEFAULTS.startUrl;
  if (!settings.rejectMessage) settings.rejectMessage = rejectMessage();
  if (!settings.reviewerStartUrl) settings.reviewerStartUrl = settings.startUrl;
  if (!settings.screeningStartUrl) settings.screeningStartUrl = settings.startUrl;
  if (!settings.eicAssessmentStartUrl) settings.eicAssessmentStartUrl = settings.startUrl;

  for (const [key, fallback] of Object.entries(DYNAMIC_DEFAULTS)) {
    if (!settings[key]) settings[key] = fallback();
  }

  return settings;
}

function readValue(key, definition, { saved, envValue }) {
  if (saved[key] !== undefined) return saved[key];

  const fallback = DYNAMIC_DEFAULTS[key]?.() ?? definition.default ?? "";
  if (!definition.env) return fallback;

  const raw = envValue(definition.env, String(fallback));
  if (definition.type === "bool") return parseBool(raw, Boolean(fallback));
  if (definition.type === "choice") {
    return ["assessmentReasoningEffort", "eicAssessmentReasoningEffort"].includes(key)
      ? normalizeAssessmentReasoningEffort(raw)
      : (definition.choices.includes(raw) ? raw : definition.default);
  }
  // Wartości wieloliniowe w .env zapisuje się z literalnym \n.
  return definition.multiline ? String(raw).replace(/\\n/g, "\n") : raw;
}

function normalizeValue(value, definition) {
  if (definition.type === "bool") return Boolean(value);

  if (definition.type === "int") {
    const parsed = Number.parseInt(value, 10);
    const minimum = definition.min ?? 0;
    if (!Number.isFinite(parsed) || parsed < minimum) {
      return definition.optional ? "" : String(definition.default);
    }
    return String(parsed);
  }

  if (definition.type === "choice") {
    if (definition.choices.includes(value)) return value;
    return definition.default;
  }

  const text = String(value || "");
  return definition.multiline ? text.trimEnd() : text.trim();
}
