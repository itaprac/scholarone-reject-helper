// Szukanie konkretnego manuskryptu po ID przez pole w nagłówku.
import { ensureHeaderSearchReady } from "../core/navigation.js";
import { REJECT_SELECTORS } from "../selectors/reject.js";
import { normalizeManuscriptId } from "../manuscript-rules.js";
import { waitForNavigationOrTimeout } from "../core/dom.js";
import { isLoginPage } from "../core/login.js";

export async function quickSearchManuscript(page, manuscriptId, {
  log = async () => undefined,
  ensureLoggedIn = async () => false,
  ensureManuscriptListReady = async () => undefined,
  countViewDetailsControls = async () => 0,
} = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await isLoginPage(page)) {
      await ensureLoggedIn(page, { reason: `quick-search-${manuscriptId}` });
    }

    let searchReady = await ensureHeaderSearchReady(page);
    if (!searchReady) {
      await log("quick_search_header_not_ready", {
        attempt,
        manuscriptId,
        url: page.url(),
        action: "navigate_to_admin_queue",
      });
      await ensureManuscriptListReady(page);
      searchReady = await ensureHeaderSearchReady(page);
    }

    if (!searchReady) {
      await log("quick_search_header_still_not_ready", {
        attempt,
        manuscriptId,
        url: page.url(),
      });
      continue;
    }

    const input = page.locator(REJECT_SELECTORS.headerSearchInput).first();
    const button = page.locator(REJECT_SELECTORS.headerSearchButton).first();
    await input.fill("");
    await input.fill(manuscriptId);

    await Promise.all([
      waitForNavigationOrTimeout(page, 12000),
      button.click({ timeout: 5000 }).catch(async () => {
        await input.press("Enter");
      }),
    ]);

    if (await isLoginPage(page)) {
      await ensureLoggedIn(page, { reason: `quick-search-after-submit-${manuscriptId}` });
      continue;
    }

    await waitForSearchResults(page, manuscriptId);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const viewDetailsControls = await countViewDetailsControls(page);
    const found = viewDetailsControls > 0 && bodyHasManuscriptId(bodyText, manuscriptId);

    return {
      found,
      manuscriptId,
      viewDetailsControls,
      url: page.url(),
      pageHasSearchResults: /search\s+results/i.test(bodyText),
      resultSnippet: bodyText.replace(/\s+/g, " ").slice(0, 500),
    };
  }

  return {
    found: false,
    manuscriptId,
    viewDetailsControls: 0,
    url: page.url(),
    note: "Quick search did not become ready after retry.",
  };
}

export async function waitForSearchResults(page, manuscriptId) {
  await page.waitForFunction((targetId) => {
    const text = document.body?.innerText || "";
    const compactText = text.toUpperCase().replace(/\s+/g, "");
    const compactId = targetId.toUpperCase().replace(/\s+/g, "");
    return /search\s+results/i.test(text) ||
      compactText.includes(compactId) ||
      /manuscripts\s+1\s*-\s*0\s+of\s+0|no\s+manuscripts|no\s+results/i.test(text);
  }, manuscriptId, { timeout: 15000 }).catch(() => undefined);
}

export function bodyHasManuscriptId(text, manuscriptId) {
  return normalizeManuscriptId(text).includes(normalizeManuscriptId(manuscriptId));
}
