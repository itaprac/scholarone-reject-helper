import { describeFields, field, modeDefinition } from "./config/options.js";

// Walidacja opcji przychodzących z panelu. Reguły biorą się z typów opisanych w
// config/options.js, więc walidator nie może już powiedzieć czegoś innego niż
// parser CLI — obie strony czytają tę samą definicję.
export function validateRunOptions(body, mode) {
  const definition = modeDefinition(mode);

  for (const descriptor of describeFields(mode)) {
    validateField(body[descriptor.key], descriptor);
  }

  if (mode.startsWith("reviewers-")) {
    validateChoice(body.reviewerQueue, { key: "reviewerQueue", ...field("reviewerQueue") }, {
      required: true,
    });

    // Tryb przygotowania zostawia otwarty pierwszy popup Invite All, więc nie ma
    // jak przejść do kolejnego artykułu — partia wymagałaby realnej wysyłki.
    if (definition.singleManuscript && Number(body.reviewerMaxManuscripts || 1) !== 1) {
      throw badRequest("Tryb przygotowania bez wysyłania obsługuje jeden manuskrypt na uruchomienie.");
    }
  }

  if (mode === "screening") {
    if (!String(body.assessmentPrompt || "").trim()) {
      throw badRequest("Prompt oceny LLM nie może być pusty.");
    }
    validateChoice(
      body.assessmentReasoningEffort || field("assessmentReasoningEffort").default,
      { key: "assessmentReasoningEffort", ...field("assessmentReasoningEffort") }
    );
    if (body.screeningLive && !String(body.screeningRejectMessage || "").trim()) {
      throw badRequest("Wiadomość Reject nie może być pusta w trybie live.");
    }
  }
}

function validateField(value, descriptor) {
  if (descriptor.type === "url") return validateUrl(value);
  if (descriptor.type === "int") return validateInteger(value, descriptor.key, descriptor.min ?? 0);
  if (descriptor.type === "choice") return validateChoice(value, descriptor);
  return undefined;
}

function validateUrl(value) {
  if (isEmpty(value)) return;

  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error("nieobsługiwany protokół");
    }
  } catch {
    throw badRequest("Start URL musi byc poprawnym adresem http:// lub https://.");
  }
}

function validateInteger(value, key, minimum) {
  if (isEmpty(value)) return;

  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw badRequest(`${key} musi byc liczba calkowita.`);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw badRequest(`${key} musi byc liczba calkowita nie mniejsza niz ${minimum}.`);
  }
}

function validateChoice(value, descriptor, { required = false } = {}) {
  if (isEmpty(value)) {
    if (!required) return;
    throw badRequest(`${descriptor.key} musi wskazywać jedną z wartości: ${descriptor.choices.join(", ")}.`);
  }
  if (!descriptor.choices.includes(value)) {
    throw badRequest(`${descriptor.key} musi mieć wartość: ${descriptor.choices.join(", ")}.`);
  }
}

function isEmpty(value) {
  return value === undefined || value === null || value === "";
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
