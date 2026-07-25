// Wysyłka zaproszeń przez Invite All. Po kliknięciu zaproszenia są wysłane i
// nie da się ich cofnąć, dlatego skutek jest potwierdzany statusami recenzentów
// albo wzrostem licznika invited — nie samym zamknięciem popupu.
import { REVIEWER_SELECTORS } from "../reviewer-selectors.js";
import { classifyReviewerStatus } from "../reviewer-rules.js";
import { TIMEOUTS } from "../core/timeouts.js";
import { samePerson } from "../reviewer-rules.js";
import { waitForNavigation } from "../core/navigation.js";
import { publicPerson } from "./page.js";

export async function openInviteAllPopup(page, log) {
  const locator = page.locator(REVIEWER_SELECTORS.firstInviteAll);
  const locatorCount = await locator.count();
  if (locatorCount !== 1) {
    throw new Error(`Oczekiwano jednego widocznego pierwszego Invite All, znaleziono ${locatorCount}.`);
  }
  await locator.waitFor({ state: "visible" });
  const href = await locator.getAttribute("href");
  const popupTarget = extractPopWindowTarget(href);
  const context = page.context();
  const existingNamedPopup = await findNamedPage(context, "invite_all_popup", page);
  await log("first_invite_all_ready", {
    url: page.url(),
    hasPopupTarget: Boolean(popupTarget),
    reusingNamedPopup: Boolean(existingNamedPopup),
  });

  const popupPromise = page.waitForEvent("popup", { timeout: 5_000 }).catch(() => null);
  const contextPagePromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
  await locator.click();
  await log("first_invite_all_clicked", { url: page.url() });

  let popup = existingNamedPopup || await Promise.race([popupPromise, contextPagePromise]);
  let openMethod = existingNamedPopup ? "reused_named_window" : "popup_event";

  if (!popup) {
    popup = await findNamedPage(context, "invite_all_popup", page);
    if (popup) openMethod = "named_window_after_click";
  }

  if (!popup && popupTarget) {
    popup = await context.newPage();
    const targetUrl = new URL(popupTarget, page.url()).href;
    await log("invite_all_popup_event_missing", {
      note: "Kliknięcie nie zgłosiło nowego popupu; otwieram ten sam pierwszy etap z adresu popWindow.",
    });
    await popup.goto(targetUrl, { waitUntil: "domcontentloaded" });
    openMethod = "popwindow_url_fallback";
  }

  if (!popup) {
    throw new Error("Kliknięto pierwszy Invite All, ale ScholarOne nie otworzył popupu i nie udało się odczytać adresu z popWindow(...).");
  }

  await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
  await popup.waitForSelector(REVIEWER_SELECTORS.finalInviteAll, { timeout: 15_000 });
  await popup.bringToFront().catch(() => undefined);
  await log("invite_all_popup_opened", { url: popup.url(), openMethod });
  return popup;
}

export function extractPopWindowTarget(href) {
  if (typeof href !== "string") return null;
  const match = href.match(/popWindow\(\s*(['"])(.*?)\1\s*,/i);
  return match?.[2]
    ?.replace(/\\x3f/gi, "?")
    .replace(/\\x26/gi, "&")
    .replace(/&amp;/gi, "&") || null;
}

export async function findNamedPage(context, expectedName, excludedPage) {
  for (const candidate of context.pages()) {
    if (candidate === excludedPage || candidate.isClosed()) continue;
    const name = await candidate.evaluate(() => window.name).catch(() => "");
    if (name === expectedName) return candidate;
  }
  return null;
}

export async function clickFinalInviteAll(popup, log) {
  const dialogMessages = [];
  const dialogHandler = async (dialog) => {
    const dialogType = dialog.type();
    const message = dialog.message();
    await dialog.accept();
    dialogMessages.push(message);
    await log("final_invite_all_dialog_accepted", { dialogType, message });
  };
  popup.on("dialog", dialogHandler);
  try {
    const locator = popup.locator(REVIEWER_SELECTORS.finalInviteAll);
    const locatorCount = await locator.count();
    if (locatorCount !== 1) {
      throw new Error(`Oczekiwano jednego widocznego finalnego Invite All, znaleziono ${locatorCount}.`);
    }
    await log("final_invite_all_click_started", { url: popup.url() });
    const closed = popup.waitForEvent("close", { timeout: 30_000 }).then(() => true).catch(() => false);
    const navigation = waitForNavigation(popup, 30_000);
    await locator.click();
    const [popupClosed] = await Promise.all([closed, navigation]);
    await log("final_invite_all_click_finished", { popupClosed, dialogMessages });
    return { clicked: true, popupClosed, dialogMessages };
  } finally {
    if (!popup.isClosed()) popup.off("dialog", dialogHandler);
  }
}

export function reviewersPendingInvitation(reviewers) {
  return reviewers.filter((reviewer) => classifyReviewerStatus(reviewer).status === "selected");
}

export function confirmInvitationsSent({ beforeCounters, afterCounters, afterReviewers, expected }) {
  const invitedIncrease = (afterCounters?.invited || 0) - (beforeCounters?.invited || 0);
  const expectedStatuses = expected.map((person) => {
    const reviewer = afterReviewers.find((item) => samePerson(person, item));
    const classification = reviewer ? classifyReviewerStatus(reviewer) : null;
    return {
      person: publicPerson(person),
      found: Boolean(reviewer),
      status: classification?.status || null,
      overdue: classification?.overdue || false,
    };
  });
  const confirmedExpected = expectedStatuses.filter(({ status }) => status === "invited").length;
  const confirmed = expected.length > 0
    ? confirmedExpected === expected.length || invitedIncrease >= expected.length
    : invitedIncrease > 0;
  return {
    confirmed,
    invitedIncrease,
    beforeCounters,
    afterCounters,
    confirmedExpected,
    expectedCount: expected.length,
    expectedStatuses,
  };
}

export async function readArticleCounters(page) {
  const text = await page.locator("body").innerText();
  const match = text.match(/(\d+)\s+active\s+selections?;\s*(\d+)\s+invited;\s*(\d+)\s+agreed;\s*(\d+)\s+declined;\s*(\d+)\s+returned/i);
  return match ? {
    activeSelections: Number(match[1]),
    invited: Number(match[2]),
    agreed: Number(match[3]),
    declined: Number(match[4]),
    returned: Number(match[5]),
  } : null;
}
