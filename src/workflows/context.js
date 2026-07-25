// Kontekst przebiegu współdzielony przez workflow. Wcześniej te same wartości
// były globalami modułu auto-reject.js — dlatego plik wykonywał się przy
// imporcie i nie dało się go przetestować bez uruchamiania przeglądarki.
//
// Teraz workflow są zwykłymi funkcjami: import niczego nie uruchamia, a test
// może podstawić własny log, własne zrzuty i własną konfigurację.
export const context = {
  config: {},
  runId: "",
  screenshots: null,
  reportDir: "",
  log: async () => undefined,
  ensureLoggedIn: async () => false,
  quickSearchManuscript: async () => ({ found: false }),
};

export function setRunContext(next) {
  Object.assign(context, next);
  return context;
}

export function hasMaxRejectedLimit() {
  return Number.isFinite(context.config.maxRejected) && context.config.maxRejected > 0;
}

export function formatRejectedProgress(rejected) {
  return hasMaxRejectedLimit()
    ? `${rejected}/${context.config.maxRejected}`
    : String(rejected);
}
