import { clickTextControl, hasVisibleTextControl, hoverTextControl } from "./dom.js";
import { TIMEOUTS } from "./timeouts.js";

// Menu "Manage" bywa rozwijane hoverem, klikiem albo strzałką po prawej — który
// wariant zadziała, zależy od szerokości okna i wersji szablonu. Próbujemy po
// kolei, aż zobaczymy pozycję potwierdzającą, że menu jest otwarte.
export async function openManageMenu(page, { confirmPattern = /admin\s+center/i } = {}) {
  const locators = [
    page.getByRole("link", { name: /\bmanage\b/i }).first(),
    page.getByRole("button", { name: /\bmanage\b/i }).first(),
    page.getByText(/\bManage\b/i).first(),
    page.locator("a, button, li, span, div").filter({ hasText: /\bManage\b/i }).first(),
  ];

  for (const locator of locators) {
    if ((await locator.count().catch(() => 0)) === 0) continue;
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);

    for (const action of ["hover", "click", "arrow-click"]) {
      if (action === "hover") {
        await locator.hover({ force: true, timeout: TIMEOUTS.probe }).catch(() => undefined);
      } else if (action === "click") {
        await locator.click({ force: true, timeout: TIMEOUTS.probe }).catch(() => undefined);
      } else {
        const box = await locator.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2);
          await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
        }
      }

      await page.waitForTimeout(TIMEOUTS.menuSettle);
      if (await hasVisibleTextControl(page, confirmPattern)) return true;
    }
  }

  // Ostatnia szansa: szukanie po samym tekście, gdy żaden locator nie trafił.
  // Rozwinięcie menu nie jest nawigacją, więc czekanie na nią tylko by zawiesiło
  // próbę na pełny limit.
  const fallbacks = [
    () => hoverTextControl(page, /\bmanage\b/i),
    () => clickTextControl(page, /\bmanage\b/i, { waitForNavigation: false }),
  ];

  for (const attempt of fallbacks) {
    if (await attempt()) {
      await page.waitForTimeout(TIMEOUTS.menuSettle);
      if (await hasVisibleTextControl(page, confirmPattern)) return true;
    }
  }

  return false;
}

// Pole szybkiego wyszukiwania bywa zwinięte za ikoną lupy.
export async function ensureHeaderSearchReady(page) {
  const input = page.locator("#QUICK_SEARCH_HEADER_SEARCH_TEXT").first();
  if (await input.isVisible({ timeout: TIMEOUTS.probe }).catch(() => false)) return true;

  const toggle = page.locator("#headerSearchbar").first();
  if (await toggle.isVisible({ timeout: TIMEOUTS.probe }).catch(() => false)) {
    await toggle.click({ timeout: TIMEOUTS.click }).catch(() => undefined);
    await page.waitForTimeout(TIMEOUTS.settle);
  }

  if (await input.isVisible({ timeout: TIMEOUTS.click }).catch(() => false)) return true;

  const toggled = await page.evaluate(() => {
    const field = document.querySelector("#QUICK_SEARCH_HEADER_SEARCH_TEXT");
    const control = document.querySelector("#headerSearchbar");
    if (!field && !control) return false;

    if (control) {
      control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      control.click();
    }
    return Boolean(document.querySelector("#QUICK_SEARCH_HEADER_SEARCH_TEXT"));
  }).catch(() => false);

  return toggled && await input.isVisible({ timeout: TIMEOUTS.click }).catch(() => false);
}

export async function waitForNavigation(page, timeout = TIMEOUTS.navigation) {
  return page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout })
    .then(() => true)
    .catch(() => false);
}
