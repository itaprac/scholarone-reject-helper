import { createBrowserSession } from "./core/browser.js";
import {
  activateLinkByText,
  clickTextControl,
  hasVisibleTextControl,
  submitScholarOneLinkByText,
  waitForCondition,
} from "./core/dom.js";
import { isLoginPage, performAutoLogin } from "./core/login.js";
import { openManageMenu } from "./core/navigation.js";
import { TIMEOUTS } from "./core/timeouts.js";

export const SCHOLARONE_QUEUE_DEFINITIONS = Object.freeze([
  queue("complete-checklist", "Complete Checklist", "Initial assessment", true),
  queue("awaiting-eic-assignment", "Awaiting EIC Assignment", "Initial assessment", true),
  queue("assign-reviewers", "Assign Reviewers", "Reviewer workflow", true),
  queue("select-reviewers", "Select Reviewers", "Reviewer workflow", true),
  queue("invite-reviewers", "Invite Reviewers", "Reviewer workflow", true),
  queue("awaiting-reviewer-scores", "Awaiting Reviewer Scores", "Reviewer follow-up", true),
  queue("overdue-reviewer-scores", "Overdue Reviewer Scores", "Reviewer follow-up", true),
  queue("rescinded-reviewer-scores", "Rescinded Reviewer Scores", "ScholarOne", false),
  queue("assign-ae", "Assign AE", "ScholarOne", false),
  queue("make-recommendation", "Make Recommendation", "ScholarOne", false),
  queue("make-final-decision", "Make Final Decision", "ScholarOne", false),
]);

export class ScholarOneStatusError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ScholarOneStatusError";
    this.code = code;
  }
}

export async function fetchScholarOneStatus({
  startUrl,
  profileDir,
  browserChannel = "",
  credentials = {},
  autoLogin = false,
}) {
  let session;

  try {
    // Status korzysta z osobnego odczytu. Nie używamy CDP, ponieważ nawigacja
    // mogłaby przejąć otwartą kartę użytkownika. ScholarOne blokuje headless
    // ekranem "Just a moment", więc stosujemy ten sam tryb okienkowy co workflow.
    session = await createBrowserSession({
      profileDir,
      browserChannel,
      cdp: "",
      headless: false,
      slowMo: 0,
      defaultTimeout: TIMEOUTS.default,
    });

    const { page } = session;
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await ensureStatusLogin(page, { credentials, autoLogin });
    await ensureAdminCenterStatusPage(page);

    return {
      state: "ready",
      fetchedAt: new Date().toISOString(),
      source: safeSource(page.url()),
      queues: await readScholarOneQueueCounts(page),
    };
  } catch (error) {
    if (error instanceof ScholarOneStatusError) throw error;
    if (/profile.*(?:in use|locked)|processsingleton|another browser|user data directory/i.test(error.message || "")) {
      throw new ScholarOneStatusError(
        "busy",
        "Profil ScholarOne jest używany przez inny przebieg. Spróbuj ponownie po jego zakończeniu.",
        { cause: error }
      );
    }
    throw new ScholarOneStatusError(
      "unavailable",
      `Nie udało się odczytać statusu ScholarOne: ${error.message}`,
      { cause: error }
    );
  } finally {
    await session?.close();
  }
}

export async function readScholarOneQueueCounts(page) {
  const values = await page.evaluate((definitions) => {
    const normalizedDefinitions = definitions.map((definition) => ({
      ...definition,
      normalizedLabel: normalize(definition.label),
    }));
    const counts = new Map();

    for (const row of document.querySelectorAll("tr")) {
      const cells = Array.from(row.querySelectorAll(":scope > td"));
      if (cells.length < 2) continue;

      const labelCell = cells.at(-1);
      const label = normalize(labelCell?.innerText || labelCell?.textContent || "");
      const definition = normalizedDefinitions.find((candidate) => candidate.normalizedLabel === label);
      if (!definition) continue;

      const countText = cells
        .slice(0, -1)
        .map((cell) => cell.innerText || cell.textContent || "")
        .join(" ");
      const match = countText.replaceAll("\u00a0", " ").match(/\b\d[\d,.\s]*\b/);
      if (!match) continue;

      const count = Number.parseInt(match[0].replace(/\D/g, ""), 10);
      if (Number.isFinite(count)) counts.set(definition.key, count);
    }

    return definitions
      .filter((definition) => counts.has(definition.key))
      .map((definition) => ({ ...definition, count: counts.get(definition.key) }));

    function normalize(value) {
      return String(value).replace(/\s+/g, " ").trim().toLowerCase();
    }
  }, SCHOLARONE_QUEUE_DEFINITIONS);

  if (values.length < 5) {
    throw new ScholarOneStatusError(
      "layout_changed",
      "ScholarOne otworzył stronę, ale nie znaleziono oczekiwanej tabeli kolejek."
    );
  }

  return values;
}

async function ensureStatusLogin(page, { credentials, autoLogin }) {
  if (!(await isLoginPage(page))) return;

  if (!autoLogin || !credentials.username || !credentials.password) {
    throw new ScholarOneStatusError(
      "auth_required",
      "Sesja ScholarOne wygasła. Uruchom dowolny workflow i zaloguj się w profilu Playwright."
    );
  }

  const result = await performAutoLogin(page, credentials);
  if (!result.loginMarkersFound && await isLoginPage(page)) {
    throw new ScholarOneStatusError(
      "auth_required",
      result.loginFailureText || "Automatyczne logowanie do ScholarOne nie powiodło się."
    );
  }
}

async function ensureAdminCenterStatusPage(page) {
  if (await hasQueueTable(page)) return;

  let activated = await submitScholarOneLinkByText(
    page,
    /^admin\s+center$/i,
    /DASHBOARD|XIK_CUR_ROLE_ID/i
  );

  if (!activated && await hasVisibleTextControl(page, /^admin\s+center$/i)) {
    activated = await activateLinkByText(page, /^admin\s+center$/i) ||
      await clickTextControl(page, /^admin\s+center$/i);
  }

  if (!activated) {
    const opened = await openManageMenu(page);
    if (opened) {
      activated = await activateLinkByText(page, /^admin\s+center$/i) ||
        await clickTextControl(page, /^admin\s+center$/i);
    }
  }

  if (!activated) {
    throw new ScholarOneStatusError(
      "navigation_failed",
      "Nie udało się otworzyć Admin Center w ScholarOne."
    );
  }

  const ready = await waitForCondition(page, () => hasQueueTable(page), {
    timeout: 15_000,
    interval: 250,
  });
  if (!ready) {
    if (await isLoginPage(page)) {
      throw new ScholarOneStatusError("auth_required", "Sesja ScholarOne wygasła podczas odczytu statusu.");
    }
    throw new ScholarOneStatusError(
      "navigation_failed",
      "Admin Center nie załadował tabeli kolejek."
    );
  }
}

async function hasQueueTable(page) {
  return page.evaluate((labels) => {
    const wanted = new Set(labels.map((label) => normalize(label)));
    let matches = 0;

    for (const row of document.querySelectorAll("tr")) {
      const cells = Array.from(row.querySelectorAll(":scope > td"));
      const label = normalize(cells.at(-1)?.innerText || cells.at(-1)?.textContent || "");
      if (wanted.has(label)) matches += 1;
    }
    return matches >= 5;

    function normalize(value) {
      return String(value).replace(/\s+/g, " ").trim().toLowerCase();
    }
  }, SCHOLARONE_QUEUE_DEFINITIONS.map(({ label }) => label)).catch(() => false);
}

function queue(key, label, workflow, focus) {
  return Object.freeze({ key, label, workflow, focus });
}

function safeSource(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "ScholarOne Admin Center";
  }
}
