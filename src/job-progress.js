// Wyciąganie postępu z linii, które automat wypisuje na stdout.
//
// Panel pokazywał dotąd tylko surowy strumień tekstu — żeby dowiedzieć się, na
// którym artykule jest przebieg, trzeba było go czytać. Tutaj te same linie są
// zamieniane na stan, z którego da się narysować pasek postępu i licznik decyzji.
const PATTERNS = [
  // [12] KES-25-0123 -> tytuł: ...
  { regex: /^\[(\d+)\]\s+(\S+)\s*->/, apply: (state, [, index, manuscriptId]) => {
    state.checked = Number(index);
    state.currentManuscriptId = manuscriptId === "NO_ID" ? null : manuscriptId;
  } },
  { regex: /^\[LLM RESULT\]\s+(\S+)\s+(APPROVE|REJECT)/, apply: (state, [, manuscriptId, decision]) => {
    state.decisions[decision] = (state.decisions[decision] || 0) + 1;
    state.lastDecision = { manuscriptId, decision };
  } },
  // Wariant sekwencyjny (tryb live) nie ma ID w linii wyniku.
  { regex: /^\[LLM RESULT\]\s+(APPROVE|REJECT):/, apply: (state, [, decision]) => {
    state.decisions[decision] = (state.decisions[decision] || 0) + 1;
  } },
  { regex: /^\[AUTO APPROVE\]/, apply: (state) => {
    state.decisions.APPROVE = (state.decisions.APPROVE || 0) + 1;
    state.automaticApprovals += 1;
  } },
  { regex: /^\[LLM ERROR\]/, apply: (state) => { state.errors += 1; } },
  { regex: /^\[LLM CACHE\]|cache z /, apply: (state) => { state.cacheHits += 1; } },
  { regex: /^\[LIVE ACTION COMPLETE\].*\((\d+)(?:\/(\d+))?\)/, apply: (state, [, done, limit]) => {
    state.liveActions = Number(done);
    if (limit) state.liveActionLimit = Number(limit);
  } },
  { regex: /^\[(\d+)\]\s+(\S+)\s*->\s*sent:/, apply: (state, [, , manuscriptId]) => {
    state.sent += 1;
    state.lastSentManuscriptId = manuscriptId;
  } },
  { regex: /^\[TOKEN SUMMARY\]\s+(.*)$/, apply: (state, [, summary]) => {
    state.tokenSummary = summary.trim();
  } },
  { regex: /pominięty: czerwony alert/, apply: (state) => { state.skipped += 1; } },
];

export function createProgressState() {
  return {
    checked: 0,
    currentManuscriptId: null,
    decisions: {},
    automaticApprovals: 0,
    cacheHits: 0,
    errors: 0,
    skipped: 0,
    sent: 0,
    lastSentManuscriptId: null,
    lastDecision: null,
    liveActions: 0,
    liveActionLimit: null,
    tokenSummary: null,
  };
}

export function applyProgressLine(state, line) {
  const text = String(line).trim();
  if (!text) return state;

  for (const { regex, apply } of PATTERNS) {
    const match = text.match(regex);
    if (match) apply(state, match);
  }
  return state;
}

export function parseProgress(output) {
  const state = createProgressState();
  for (const line of String(output).split(/\r?\n/)) {
    applyProgressLine(state, line);
  }
  return state;
}
