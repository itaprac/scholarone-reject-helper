// Odczyt stanu stron ScholarOne w trybie recenzentów: rozpoznanie rodzaju
// strony, lista recenzentów, lista kandydatów i paginacja.
import { REVIEWER_SELECTORS } from "../reviewer-selectors.js";
import { classifyReviewerStatus, countReviewersTowardTarget, parseListRange, samePerson } from "../reviewer-rules.js";
import { evaluateAfterNavigation } from "../core/dom.js";
import { waitForNavigation } from "../core/navigation.js";
import { TIMEOUTS } from "../core/timeouts.js";

export async function detectReviewerPageState(page, queueLabel = null) {
  return page.evaluate(({ queueActionSelector, expectedQueue }) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 &&
        style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const bodyText = clean(document.body?.innerText);
    const passwordVisible = Array.from(document.querySelectorAll("input[type='password']")).some(visible);
    const usernameVisible = Array.from(document.querySelectorAll("input")).some((input) =>
      visible(input) && /USERID|user\s*name|user\s*id|login/i.test([
        input.id,
        input.name,
        input.placeholder,
        input.getAttribute("aria-label"),
      ].filter(Boolean).join(" "))
    );
    const loginVisible = Array.from(document.querySelectorAll(
      "a, button, input[type='button'], input[type='submit'], input[type='image']"
    )).some((element) => visible(element) && /log\s*in|sign\s*in/i.test(clean([
      element.textContent,
      element.getAttribute("value"),
      element.getAttribute("title"),
      element.getAttribute("aria-label"),
    ].filter(Boolean).join(" "))));
    const loggedInMarker = /log\s*out|admin\s+(?:center|dashboard)|(?:assign|select|invite)\s+reviewers/i.test(bodyText) ||
      Boolean(document.querySelector("#QUICK_SEARCH_HEADER_SEARCH_TEXT"));
    if ((passwordVisible || (usernameVisible && loginVisible)) && !loggedInMarker) return "login";

    const currentPage = document.querySelector("input[name='CURRENT_PAGE']")?.value || "";
    const reviewerHeading = Array.from(document.querySelectorAll("b"))
      .find((element) => /^reviewer\s+list$/i.test(clean(element.textContent)));
    const reviewerHeaderText = clean(reviewerHeading?.closest("tr")?.innerText);
    const reviewerArticle = currentPage === "MANUSCRIPT_DETAILS" &&
      /\d+\s*-\s*\d+\s+of\s+\d+/i.test(reviewerHeaderText) &&
      /reviewer\s+list/i.test(bodyText);
    if (reviewerArticle) return "reviewer_article";

    if (currentPage === "DASHBOARD" && /admin\s+(?:center|dashboard)/i.test(bodyText)) return "admin_center";

    if (currentPage === "ADMIN_VIEW_MANUSCRIPTS") {
      const headings = Array.from(document.querySelectorAll("b")).map((element) => clean(element.textContent));
      if (expectedQueue && headings.some((text) => text.toLowerCase() === expectedQueue.toLowerCase())) {
        return "reviewer_queue";
      }
      if (document.querySelector(queueActionSelector) || headings.length > 0) return "other_admin_queue";
    }

    return loggedInMarker ? "logged_in_other" : "unknown";
  }, {
    queueActionSelector: REVIEWER_SELECTORS.queueAction,
    expectedQueue: queueLabel,
  }).catch(() => "unknown");
}

export async function waitForReviewerArticle(page, timeout = 20_000) {
  await waitForReviewerListReady(page, timeout);
  await page.waitForFunction((reviewerRowSelector) => {
    const text = document.body?.innerText || "";
    return /reviewer\s+list/i.test(text) &&
      (/potential\s+reviewer\s+details/i.test(text) || document.querySelector(reviewerRowSelector));
  }, REVIEWER_SELECTORS.reviewerRow, { timeout });
}

export async function waitForReviewerListReady(page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastState = { headerText: "", bodyText: "" };

  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 1_000 }).catch(() => undefined);
    const state = await page.evaluate(() => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const heading = Array.from(document.querySelectorAll("b"))
        .find((element) => /^reviewer\s+list$/i.test(clean(element.textContent)));
      const headerText = clean(heading?.closest("tr")?.innerText || heading?.closest("tr")?.textContent);
      return {
        ready: /(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i.test(headerText),
        headerText,
        bodyText: clean(document.body?.innerText).slice(0, 160),
      };
    }).catch(() => null);

    if (state?.ready) return state;
    if (state) lastState = state;
    await page.waitForTimeout(250).catch(() => undefined);
  }

  const observed = lastState.headerText || lastState.bodyText || "(pusta strona)";
  throw new Error(`Reviewer List nie osiągnęła gotowego stanu. Ostatnia treść: ${observed}`);
}

export async function readManuscriptIdentity(page) {
  const text = await page.locator("body").innerText();
  const manuscriptId = text.match(/\b([A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?)\b/i)?.[1]?.toUpperCase() || null;
  const title = await page.evaluate(() => {
    const body = document.body?.innerText || "";
    const match = body.match(/\b[A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?\b[^\n]*\n([^\n]+)/i);
    return match?.[1]?.trim() || null;
  }).catch(() => null);
  return { manuscriptId, title };
}

export async function readReviewerPage(page) {
  await waitForReviewerListReady(page);
  const raw = await evaluateAfterNavigation(page, (rowSelector) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const heading = Array.from(document.querySelectorAll("b"))
      .find((element) => /^reviewer\s+list$/i.test(clean(element.textContent)));
    const headerText = clean(heading?.closest("tr")?.innerText || heading?.closest("tr")?.textContent);
    const reviewers = Array.from(document.querySelectorAll(rowSelector)).map((input) => {
      const row = input.closest("tr");
      const cells = Array.from(row?.children || []).filter((element) => element.tagName === "TD");
      const nameCell = cells[1];
      const linkedName = Array.from(nameCell?.querySelectorAll("a") || [])
        .map((link) => clean(link.textContent))
        .find((text) => text && !/^(proxy|grant an extension|invite again|rescind|edit reminders)$/i.test(text)) || null;
      const plainTextName = String(nameCell?.innerText || nameCell?.textContent || "")
        .split(/\r?\n/)
        .map(clean)
        .find((text) => text && !/^(proxy|grant an extension|invite again|rescind|edit reminders)$/i.test(text)) || null;
      const name = linkedName || plainTextName;
      const rowText = clean(row?.innerText || row?.textContent);
      return {
        id: input.getAttribute("value") || input.getAttribute("name"),
        name,
        email: rowText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null,
        status: clean(cells[2]?.innerText || cells[2]?.textContent),
        history: clean(cells[3]?.innerText || cells[3]?.textContent),
      };
    });
    return { headerText, reviewers };
  }, REVIEWER_SELECTORS.reviewerRow);

  const range = parseListRange(raw.headerText);
  if (!range) throw new Error(`Nie można odczytać zakresu Reviewer List z: ${raw.headerText || "(pusty nagłówek)"}`);
  if (range.empty) return { range, reviewers: [] };
  return { range, reviewers: raw.reviewers.filter(({ name }) => Boolean(name)) };
}

export async function readAllReviewerList(page, log = async () => undefined) {
  const pagination = await readPagination(page, REVIEWER_SELECTORS.reviewerPagination);
  const originalValue = pagination?.value || null;
  const values = pagination?.options.map(({ value }) => value) || [null];
  const reviewers = [];
  let reportedTotal = null;

  for (const value of values.slice(0, 50)) {
    if (value !== null && value !== (await currentPaginationValue(page, REVIEWER_SELECTORS.reviewerPagination))) {
      await navigatePagination(page, REVIEWER_SELECTORS.reviewerPagination, value);
    }
    const pageData = await readReviewerPage(page);
    reportedTotal = pageData.range.total;
    for (const reviewer of pageData.reviewers) {
      if (!reviewers.some((existing) => existing.id === reviewer.id || samePerson(existing, reviewer))) {
        reviewers.push(reviewer);
      }
    }
    await log("reviewer_list_page_read", {
      pageValue: value,
      range: pageData.range,
      rows: pageData.reviewers.length,
    });
  }

  if (originalValue && originalValue !== (await currentPaginationValue(page, REVIEWER_SELECTORS.reviewerPagination))) {
    await navigatePagination(page, REVIEWER_SELECTORS.reviewerPagination, originalValue);
  }
  if (reportedTotal !== null && reviewers.length < reportedTotal) {
    throw new Error(`Reviewer List zgłasza ${reportedTotal} osób, ale odczytano tylko ${reviewers.length}.`);
  }
  return reviewers;
}

export async function readCandidatePage(page) {
  return evaluateAfterNavigation(page, (selector) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll(selector)).map((link) => {
      const row = link.closest("tr");
      const cells = Array.from(row?.children || []).filter((element) => element.tagName === "TD");
      const details = cells[0];
      const text = clean(details?.innerText || details?.textContent);
      const href = link.getAttribute("href") || "";
      return {
        id: href.match(/XIK_POTENTIAL_REVIEWER_ID['"=,\s]+['"]?([^'"),;\s]+)/i)?.[1] ||
          href.match(/['"](xik_[A-Za-z0-9]+)['"]\s*,\s*\$\(/)?.[1] ||
          null,
        name: clean(details?.querySelector("b")?.textContent) || null,
        email: text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null,
        href,
        popupExpected: /openCreateAccountPopupForRLResult/i.test(href),
      };
    }).filter(({ id, name }) => id && name);
  }, REVIEWER_SELECTORS.candidateAdd);
}

export async function readPagination(page, selector) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) return null;
  return evaluateAfterNavigation(page, (paginationSelector) => {
    const select = document.querySelector(paginationSelector);
    if (!select) return null;
    return {
      value: select.value,
      options: Array.from(select.options).map((option) => ({
        value: option.value,
        text: (option.textContent || "").replace(/\s+/g, " ").trim(),
      })),
    };
  }, selector);
}

export async function currentPaginationValue(page, selector) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) return null;
  return locator.inputValue({ timeout: 1_000 }).catch(() => null);
}

export async function navigatePagination(page, selector, value) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) throw new Error(`Zniknęła kontrolka paginacji ${selector}.`);
  // ScholarOne submits the entire form here. With slowMo the navigation can
  // start more than three seconds after selectOption, so the general-purpose
  // short navigation helper is not sufficient for pagination.
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  }).then(() => true).catch(() => false);
  await locator.selectOption(String(value));
  const navigated = await navigation;
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForFunction(
    ({ paginationSelector, expectedValue }) =>
      document.querySelector(paginationSelector)?.value === expectedValue,
    { paginationSelector: selector, expectedValue: String(value) },
    { timeout: navigated ? 5_000 : 10_000 }
  );
}

export function publicReviewer(reviewer) {
  const classification = classifyReviewerStatus(reviewer);
  return {
    name: reviewer.name,
    email: reviewer.email || null,
    status: reviewer.status,
    history: reviewer.history,
    classification: classification.status,
    overdue: classification.overdue,
  };
}

export function publicPerson(person) {
  return { name: person.name, email: person.email || null };
}

export function summarizeReviewerList(reviewers, countTowardTarget) {
  return {
    total: reviewers.length,
    countTowardTarget,
    reviewers: reviewers.map(publicReviewer),
  };
}

export async function isReviewerQueuePage(page, queueLabel) {
  return (await detectReviewerPageState(page, queueLabel)) === "reviewer_queue";
}
