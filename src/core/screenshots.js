import path from "node:path";

// Zrzuty ekranu dzielą się na dwa poziomy:
//   "always" — błędy i dowody akcji nieodwracalnych (wysłany mail, zaproszenie).
//              Zawsze trafiają na dysk, bo bez nich nie da się odtworzyć, co się stało.
//   "debug"  — zrzuty pomocnicze z każdego kroku. Domyślnie wyłączone, bo to one
//              odpowiadały za setki megabajtów w logs/screenshots/.
export const SCREENSHOT_LEVELS = Object.freeze({ always: "always", debug: "debug" });

export function createScreenshotWriter({ directory, debug = false } = {}) {
  if (!directory) {
    throw new Error("createScreenshotWriter wymaga katalogu docelowego.");
  }

  async function capture(page, name, { level = SCREENSHOT_LEVELS.debug } = {}) {
    if (level === SCREENSHOT_LEVELS.debug && !debug) {
      return null;
    }
    if (!page || page.isClosed?.()) {
      return null;
    }

    const filename = `${String(name).replace(/[^a-z0-9-]+/gi, "-")}.png`;
    const absolutePath = path.join(directory, filename);
    await page.screenshot({ path: absolutePath, fullPage: true }).catch(() => undefined);
    return absolutePath;
  }

  return {
    directory,
    debugEnabled: debug,
    capture,
    // Błąd albo krok wymagający ręcznej weryfikacji.
    error: (page, name) => capture(page, name, { level: SCREENSHOT_LEVELS.always }),
    // Dowód wykonania operacji, której nie da się cofnąć.
    proof: (page, name) => capture(page, name, { level: SCREENSHOT_LEVELS.always }),
    // Krok pomocniczy — tylko przy --debug-screenshots.
    step: (page, name) => capture(page, name, { level: SCREENSHOT_LEVELS.debug }),
  };
}
