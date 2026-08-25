import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ASSESSMENT_MODEL,
  DEFAULT_ASSESSMENT_REASONING_EFFORT,
} from "../assessment-config.js";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

// Jedyne miejsce z wartościami domyślnymi. Wcześniej ten sam adres czasopisma
// był wpisany w czterech plikach, a liczby powtarzały się dodatkowo w
// atrybutach value= w ui/index.html.
export const DEFAULTS = Object.freeze({
  startUrl: "https://mc.manuscriptcentral.com/kes",

  // Odrzucanie z kolejki Complete Checklist.
  maxChecked: 10,
  submittedOlderThanDays: 30,
  slowMo: 0,
  queueStartPage: 0,

  // Wybór recenzentów.
  reviewersPerPaper: 10,
  reviewerMaxManuscripts: 10,
  reviewerRefreshWaitSeconds: 60,
  reviewerQueue: "combined",

  // Wstępna ocena LLM.
  screeningMaxChecked: 100,
  eicAssessmentMaxChecked: 100,
  assessmentModel: DEFAULT_ASSESSMENT_MODEL,
  assessmentReasoningEffort: DEFAULT_ASSESSMENT_REASONING_EFFORT,
  assessmentTimeoutSeconds: 120,
  // Ocena to podproces, nie ruch sieciowy z tej maszyny — trójka trzyma
  // obciążenie w ryzach, a i tak usuwa większość czasu bezczynności.
  assessmentConcurrency: 3,

  // Domyślny bezpiecznik trybów live. Świadomie ustawiony, a nie nieskończony:
  // --scan-all-metadata puszcza całą kolejkę, więc jedno przeoczenie w prompcie
  // mogłoby skończyć się dziesiątkami wysłanych wiadomości.
  maxLiveActions: 100,

  // Katalogi.
  profileDir: path.join(projectRoot, "playwright-profile"),
  logsDir: path.join(projectRoot, "logs"),

  headless: false,
  debugScreenshots: false,
});

// Panel startuje z ostrożniejszymi liczbami niż goły CLI: spowolnienie klikania
// i większy zakres kolejki są tam wygodniejsze, a użytkownik i tak je widzi.
export const UI_DEFAULTS = Object.freeze({
  ...DEFAULTS,
  maxChecked: 200,
  slowMo: 500,
});

export const REVIEWER_QUEUES = Object.freeze(["combined", "select", "invite"]);
