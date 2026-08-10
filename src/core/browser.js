import { chromium } from "playwright";
import { TIMEOUTS } from "./timeouts.js";

// Dwa tryby uruchomienia: podpięcie się do już otwartego Chrome przez CDP albo
// własny trwały profil w playwright-profile/ (tam ScholarOne pamięta "Remember
// this device" i nie pyta o kod z maila przy każdym przebiegu).
export async function createBrowserSession(config) {
  if (config.cdp) {
    const browser = await chromium.connectOverCDP(config.cdp, {
      noDefaults: true,
      slowMo: config.slowMo,
    });

    const context = browser.contexts()[0];
    if (!context) {
      throw new Error(`Nie udało się znaleźć kontekstu Chrome pod ${config.cdp}`);
    }

    const page =
      context.pages().find((candidate) => /manuscriptcentral\.com/i.test(candidate.url())) ||
      context.pages().find((candidate) => candidate.url() !== "about:blank") ||
      context.pages()[0] ||
      (await context.newPage());

    page.setDefaultTimeout(config.defaultTimeout || TIMEOUTS.default);
    return {
      page,
      close: () => browser.close().catch(() => undefined),
    };
  }

  const context = await chromium.launchPersistentContext(config.profileDir, {
    channel: config.browserChannel || undefined,
    headless: config.headless,
    slowMo: config.slowMo,
    viewport: { width: 1440, height: 1000 },
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(config.defaultTimeout || TIMEOUTS.default);

  return {
    page,
    close: () => context.close().catch(() => undefined),
  };
}
