// Poruszanie się po kolejce Complete Checklist: otwieranie kolejnych artykułów,
// paginacja listy i powroty. Zależności przebiegu (log, ensureLoggedIn, config)
// są wstrzykiwane przez setQueueContext, żeby moduł nie sięgał po globale.
import { activateLinkByText, clickTextControl, findHrefByText, hasVisibleTextControl, submitScholarOneLinkByText, waitForCondition, waitForNavigationOrTimeout } from "../core/dom.js";
import { openManageMenu } from "../core/navigation.js";
import { isLoginPage } from "../core/login.js";
import { TIMEOUTS } from "../core/timeouts.js";
import { REJECT_PATTERNS, REJECT_SELECTORS } from "../selectors/reject.js";
import { inspectManuscriptText, normalizeManuscriptId } from "../manuscript-rules.js";
import { submitScholarOneLinkByImageAlt } from "./reject-email.js";

// Kontekst przebiegu ustawiany raz przy starcie.
export const QUEUE_CONTEXT_KEYS = Object.freeze(["config", "log", "ensureLoggedIn", "screenshots"]);

let ctx = {
  config: {},
  log: async () => undefined,
  ensureLoggedIn: async () => false,
  screenshots: null,
};

export function setQueueContext(next) {
  // Nieznany klucz to zwykle literówka po stronie wywołującego. Bez tego
  // sprawdzenia wchodziłby po cichu do obiektu i ujawniał się dopiero jako
  // undefined w środku przebiegu.
  for (const key of Object.keys(next || {})) {
    if (!QUEUE_CONTEXT_KEYS.includes(key)) {
      throw new Error(`setQueueContext: nieznany klucz kontekstu "${key}".`);
    }
  }
  ctx = { ...ctx, ...next };
}

export async function navigateToCompleteChecklistQueue(page) {
  return navigateToAdminQueue(page, "Complete Checklist");
}

export async function navigateToAdminQueue(page, queueLabel) {
  const queuePattern = new RegExp(`^${escapeRegExp(queueLabel).replace(/\s+/g, "\\s+")}$`, "i");
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await dismissCookieBanner(page);

  if (await isAdminQueueEmpty(page, queueLabel) ||
      ((await countViewDetailsControls(page)) > 0 && await isCurrentAdminQueue(page, queueLabel))) {
    return true;
  }

  await ctx.log("navigate_to_queue_started", {
    url: page.url(),
  });

  const adminVisible = await hasVisibleTextControl(page, /admin\s+center/i);
  await ctx.log("navigate_to_queue_probe", {
    step: "initial",
    adminVisible,
    adminHref: await findHrefByText(page, /admin\s+center/i),
    queueLabel,
    queueHref: await findHrefByText(page, queuePattern),
  });

  const adminHref = await findHrefByText(page, /admin\s+center/i);
  let adminNowVisible = await hasVisibleTextControl(page, /admin\s+center/i);
  let adminClicked = false;
  let adminSubmitAttempted = false;

  adminSubmitAttempted = await submitScholarOneLinkByText(page, /\badmin\s+center\b/i);
  if (adminSubmitAttempted) {
    adminClicked = true;
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  } else if (await activateLinkByText(page, /\badmin\s+center\b/i)) {
    adminClicked = true;
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  } else {
    if (!adminVisible) {
      const manageClicked = await openManageMenu(page);
      if (!manageClicked) {
        await ctx.log("navigate_to_queue_failed", {
          step: "manage",
          url: page.url(),
        });
        return false;
      }
    }

    adminNowVisible = await hasVisibleTextControl(page, /admin\s+center/i);
  }

  if (!adminClicked && adminNowVisible) {
    adminClicked = await clickTextControl(page, REJECT_PATTERNS.adminCenter);
    if (adminClicked) {
      await waitForLikelyNavigation(page);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
  } else if (!adminClicked && adminHref) {
    adminClicked = true;
    await page.goto(adminHref, { waitUntil: "domcontentloaded" });
  }

  await ctx.log("navigate_to_queue_probe", {
    step: "admin",
    adminNowVisible,
    adminClicked,
    adminSubmitAttempted,
    adminHref,
    url: page.url(),
  });

  if (await isAdminQueueEmpty(page, queueLabel) ||
      ((await countViewDetailsControls(page)) > 0 && await isCurrentAdminQueue(page, queueLabel))) {
    return true;
  }

  let checklistClicked = await submitScholarOneLinkByText(page, queuePattern) ||
    await activateLinkByText(page, queuePattern) ||
    (queueLabel === "Complete Checklist" && await clickTextControl(page, REJECT_PATTERNS.completeChecklistExact)) ||
    (queueLabel === "Complete Checklist" && await clickTextControl(page, REJECT_PATTERNS.completeChecklist));

  if (checklistClicked) {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await waitForCondition(page, async () =>
      await isCurrentAdminQueue(page, queueLabel) &&
      ((await countViewDetailsControls(page)) > 0 || await isAdminQueueEmpty(page, queueLabel)), {
      timeout: TIMEOUTS.navigation,
    });
  } else {
    const checklistHref = await findHrefByText(page, queuePattern);
    if (checklistHref) {
      checklistClicked = true;
      await page.goto(checklistHref, { waitUntil: "domcontentloaded" });
    }
  }

  const ready = await isCurrentAdminQueue(page, queueLabel) &&
    ((await countViewDetailsControls(page)) > 0 || await isAdminQueueEmpty(page, queueLabel));
  await ctx.log("navigate_to_queue_finished", {
    ready,
    queueLabel,
    checklistClicked,
    checklistHref: await findHrefByText(page, queuePattern),
    url: page.url(),
  });
  return ready;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function dismissCookieBanner(page) {
  const cookieButtons = [
    page.getByRole("button", { name: /accept\s+all\s+cookies/i }),
    page.getByRole("button", { name: /reject\s+all/i }),
    page.getByRole("button", { name: /^x$|close/i }),
    page.locator(REJECT_SELECTORS.cookieAccept).filter({ hasText: REJECT_PATTERNS.cookieAccept }),
  ];

  for (const locator of cookieButtons) {
    if ((await locator.count().catch(() => 0)) === 0) {
      continue;
    }

    const button = locator.first();
    await button.click({ timeout: TIMEOUTS.probe }).catch(() => undefined);
    // Czekamy, aż baner faktycznie zniknie, zamiast zgadywać, ile mu to zajmie.
    // Dopóki zasłania stronę, każde kolejne kliknięcie trafia w niego.
    await waitForCondition(page, async () => !(await button.isVisible().catch(() => false)), {
      timeout: TIMEOUTS.click,
    });
    return;
  }
}

export async function isCompleteChecklistQueueEmpty(page) {
  return isAdminQueueEmpty(page, "Complete Checklist");
}

export async function isAdminQueueEmpty(page, queueLabel) {
  if (await isCurrentAdminQueue(page, queueLabel) && await countViewDetailsControls(page) === 0) {
    const emptyMessage = await page.locator("body").innerText().catch(() => "");
    if (/\bno\s+manuscripts\s+(?:(?:are|were)\s+)?(?:in\s+this\s+queue|found)|\b0\s*-\s*0\s+of\s+0\b/i.test(emptyMessage)) {
      return true;
    }
  }
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return text;
  }).then((text) => new RegExp(`(?:^|\\s)0\\s+${escapeRegExp(queueLabel).replace(/\s+/g, "\\s+")}(?:\\s|$)`, "i")
    .test(text)).catch(() => false);
}

export async function isCurrentAdminQueue(page, queueLabel) {
  return page.evaluate((expectedQueue) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const currentPage = document.querySelector("input[name='CURRENT_PAGE']")?.value || "";
    if (currentPage !== "ADMIN_VIEW_MANUSCRIPTS") return false;
    return Array.from(document.querySelectorAll("b")).some(
      (element) => clean(element.textContent).toLowerCase() === expectedQueue.toLowerCase()
    );
  }, queueLabel).catch(() => false);
}

export async function countViewDetailsControls(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(() => {
        const selects = Array.from(document.querySelectorAll("select"));
        const matchingSelects = selects.filter((select) =>
          /^SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_/i.test(select.name || "") &&
          Array.from(select.options).some((option) => /view\s+details/i.test(option.textContent || ""))
        );

        return matchingSelects.length;
      });
    } catch (error) {
      if (!/execution context|navigation|destroyed/i.test(error.message || "") || attempt === 2) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      // Odczekanie przed ponowną próbą: kontekst został właśnie zniszczony przez
      // nawigację i potrzebuje chwili, zanim evaluate znowu ma sens.
      await page.waitForTimeout(500);
    }
  }

  return 0;
}

export async function openViewDetailsByIndex(page, index) {
  const openedBySelect = await openViewDetailsSelectByIndex(page, index);
  if (openedBySelect) {
    return true;
  }

  return openViewDetailsClickableByIndex(page, index);
}

export async function openNextUnseenViewDetails(page, seenManuscriptIds) {
  const target = await findNextUnseenViewDetailsSelect(page, seenManuscriptIds);
  if (!target) {
    return false;
  }

  await ctx.log("open_view_details_started", {
    listIndex: target.index,
    manuscriptIdFromList: target.manuscriptId,
  });

  return openViewDetailsByIndex(page, target.index);
}

export async function openNextUnseenViewDetailsAcrossQueuePages(page, seenManuscriptIds) {
  if (await isAdminQueueEmpty(page, ctx.config.assessmentQueueLabel || "Complete Checklist")) return false;
  const visitedQueuePages = new Set();
  const maxQueuePageHops = ctx.config.scanAllMetadata
    ? 500
    : Math.max(3, Math.ceil(ctx.config.maxChecked / 10) + 5);

  for (let hop = 0; hop < maxQueuePageHops; hop += 1) {
    const pageInfo = await readQueuePageInfo(page);
    const queuePageKey = pageInfo?.selectedValue || pageInfo?.selectedLabel || `unknown-${hop}`;

    const opened = await openNextUnseenViewDetails(page, seenManuscriptIds);
    if (opened) {
      return true;
    }

    await ctx.log("queue_page_has_no_unseen_view_details", {
      hop,
      selectedValue: pageInfo?.selectedValue || null,
      selectedLabel: pageInfo?.selectedLabel || null,
      seenCount: seenManuscriptIds.size,
    });

    if (visitedQueuePages.has(queuePageKey)) {
      await ctx.log("queue_page_loop_detected", {
        hop,
        queuePageKey,
      });
      return false;
    }
    visitedQueuePages.add(queuePageKey);

    const advanced = await advanceQueueListPage(page);
    if (!advanced.advanced) {
      await ctx.log("queue_page_advance_unavailable", {
        hop,
        ...advanced,
      });
      return false;
    }

    await ctx.log("queue_page_advanced", {
      hop,
      ...advanced,
    });

    await ensureManuscriptListReady(page);
  }

  await ctx.log("queue_page_hop_limit_reached", {
    maxQueuePageHops,
    seenCount: seenManuscriptIds.size,
  });
  return false;
}

export async function openViewDetailsByManuscriptIdAcrossQueuePages(page, manuscriptId) {
  if (await isAdminQueueEmpty(page, ctx.config.assessmentQueueLabel || "Complete Checklist")) return false;
  const targetId = normalizeManuscriptId(manuscriptId);
  const visitedQueuePages = new Set();

  for (let hop = 0; hop < 500; hop += 1) {
    const pageInfo = await readQueuePageInfo(page);
    const queuePageKey = pageInfo?.selectedValue || pageInfo?.selectedLabel || `unknown-${hop}`;
    if (visitedQueuePages.has(queuePageKey)) return false;
    visitedQueuePages.add(queuePageKey);

    const index = await page.evaluate((expectedId) => {
      const selects = Array.from(
        document.querySelectorAll("select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']")
      ).filter((select) => Array.from(select.options)
        .some((option) => /view\s+details/i.test(option.textContent || "")));
      return selects.findIndex((select) => {
        const rowText = (select.closest("tr")?.innerText || "").toUpperCase();
        const rowIds = rowText.match(/\b[A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?\b/g) || [];
        return rowIds.length === 1 && rowIds[0] === expectedId;
      });
    }, targetId).catch(() => -1);

    if (index >= 0) return openViewDetailsByIndex(page, index);
    const advanced = await advanceQueueListPage(page);
    if (!advanced.advanced) return false;
    await ensureManuscriptListReady(page);
  }

  return false;
}

// Otwiera konkretną akcję z dropdownu właściwego manuskryptu. ScholarOne po
// przypisaniu EIC i AE przenosi REJECT do kolejki Select Reviewers; na stronie
// artykułu nie ma wtedy zakładki Immediate Decision, ale pozostaje ona dostępna
// bezpośrednio w dropdownie kolejki.
export async function openManuscriptTabByIdAcrossQueuePages(
  page,
  manuscriptId,
  tabPattern,
  { navigationTimeout = 12_000, queueLabel = ctx.config.assessmentQueueLabel || "Complete Checklist" } = {}
) {
  if (await isAdminQueueEmpty(page, queueLabel)) return false;
  const targetId = normalizeManuscriptId(manuscriptId);
  const visitedQueuePages = new Set();

  for (let hop = 0; hop < 500; hop += 1) {
    const pageInfo = await readQueuePageInfo(page);
    const queuePageKey = pageInfo?.selectedValue || pageInfo?.selectedLabel || `unknown-${hop}`;
    if (visitedQueuePages.has(queuePageKey)) return false;
    visitedQueuePages.add(queuePageKey);

    const target = await page.evaluate(({ expectedId, tabSource }) => {
      const regex = new RegExp(tabSource, "i");
      const selects = Array.from(
        document.querySelectorAll("select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']")
      );
      for (let index = 0; index < selects.length; index += 1) {
        const select = selects[index];
        const rowText = (select.closest("tr")?.innerText || "").toUpperCase();
        const rowIds = rowText.match(/\b[A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?\b/g) || [];
        if (rowIds.length !== 1 || rowIds[0] !== expectedId) continue;
        const option = Array.from(select.options).find((candidate) =>
          regex.test((candidate.textContent || "").replace(/\s+/g, " ").trim())
        );
        if (option) return { index, value: option.value };
      }
      return null;
    }, { expectedId: targetId, tabSource: tabPattern.source }).catch(() => null);

    if (target) {
      const select = page.locator(REJECT_SELECTORS.queueAction).nth(target.index);
      const navigation = waitForNavigationOrTimeout(page, navigationTimeout);
      await select.selectOption(target.value);
      await navigation;
      return true;
    }

    const advanced = await advanceQueueListPage(page, queueLabel);
    if (!advanced.advanced) return false;
    await ensureManuscriptListReady(page, queueLabel);
  }

  return false;
}

export async function findNextUnseenViewDetailsSelect(page, seenManuscriptIds) {
  return page.evaluate((seenIds) => {
    const seen = new Set(seenIds);
    const selects = Array.from(
      document.querySelectorAll("select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']")
    ).filter((select) =>
      Array.from(select.options).some((option) => /view\s+details/i.test(option.textContent || ""))
    );

    let firstWithoutId = null;

    for (let index = 0; index < selects.length; index += 1) {
      const select = selects[index];
      const row = select.closest("tr");
      const rowText = row?.innerText || "";
      const match = rowText.match(/\b([A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?)\b/i);
      const manuscriptId = match ? match[1].toUpperCase() : null;

      if (!manuscriptId) {
        firstWithoutId ??= { index, manuscriptId: null };
        continue;
      }

      if (!seen.has(manuscriptId)) {
        return { index, manuscriptId };
      }
    }

    return firstWithoutId;
  }, Array.from(seenManuscriptIds)).catch(() => null);
}

export async function readQueuePageInfo(page) {
  return page.evaluate(() => {
    const select = document.querySelector("select[name='page_select']");
    if (!select) {
      return null;
    }

    const selectedOption = select.options[select.selectedIndex] || null;
    const nextOption = select.options[select.selectedIndex + 1] || null;
    return {
      selectedValue: selectedOption?.value || select.value || null,
      selectedLabel: selectedOption?.textContent?.replace(/\s+/g, " ").trim() || null,
      nextValue: nextOption?.value || null,
      nextLabel: nextOption?.textContent?.replace(/\s+/g, " ").trim() || null,
      optionCount: select.options.length,
    };
  }).catch(() => null);
}

export async function advanceQueueListPage(page, queueLabel = ctx.config.assessmentQueueLabel || "Complete Checklist") {
  const before = await readQueuePageInfo(page);
  if (!before?.nextValue) {
    return {
      advanced: false,
      reason: "No next page option in page_select.",
      fromValue: before?.selectedValue || null,
      fromLabel: before?.selectedLabel || null,
    };
  }

  const pageChange = await goToQueueListPage(page, before.nextValue, true, queueLabel);
  return {
    advanced: pageChange.changed,
    reason: pageChange.reason,
    fromValue: pageChange.fromValue,
    fromLabel: pageChange.fromLabel,
    toValue: pageChange.toValue,
    toLabel: pageChange.toLabel,
  };
}

export async function goToQueueListPage(page, targetPageValue, retryAfterLogin = true,
  queueLabel = ctx.config.assessmentQueueLabel || "Complete Checklist") {
  const before = await readQueuePageInfo(page);
  const targetValue = String(targetPageValue);
  if (!before) {
    return {
      changed: false,
      reason: "No page_select found.",
      fromValue: null,
      fromLabel: null,
      toValue: targetValue,
      toLabel: null,
    };
  }

  if (before.selectedValue === targetValue) {
    return {
      changed: false,
      reason: "Already on requested queue page.",
      fromValue: before.selectedValue,
      fromLabel: before.selectedLabel,
      toValue: targetValue,
      toLabel: before.selectedLabel,
    };
  }

  const navigation = waitForNavigationOrTimeout(page, 12000);
  let submitted = false;
  try {
    submitted = await page.evaluate((targetValue) => {
      const form = document.forms[0];
      const select = document.querySelector("select[name='page_select']");
      if (!form || !select) {
        return false;
      }

      const targetOption = Array.from(select.options).find((option) => option.value === targetValue);
      if (!targetOption) {
        return false;
      }

      if (select.value === targetOption.value) {
        return true;
      }

      setFormValue("CURRENT_PAGE_NO", targetOption.value);
      setFormValue("JUST_PAGED", "TRUE");
      setFormValue("SEARCH_SHOW_ALL_ATTRIB_LEVELS", "N");
      setFormValue("NEXT_PAGE", "ADMIN_VIEW_MANUSCRIPTS");

      if (form.elements.PAGE_LOADED_FLAG) {
        form.elements.PAGE_LOADED_FLAG.value = "N";
      }
      if (window.getPostParams) {
        window.getPostParams();
      }

      form.target = "";
      HTMLFormElement.prototype.submit.call(form);
      return true;

      function setFormValue(name, value) {
        let field = form.elements[name];
        if (field && field.length && field.tagName === undefined) {
          field = field[0];
        }

        if (!field) {
          field = document.createElement("input");
          field.type = "hidden";
          field.name = name;
          form.appendChild(field);
        }

        field.value = value;
      }
    }, targetValue);
  } catch (error) {
    submitted = /execution context|navigation|destroyed/i.test(error.message || "");
  }

  if (!submitted) {
    return {
      changed: false,
      reason: "Could not submit target page_select page.",
      fromValue: before.selectedValue,
      fromLabel: before.selectedLabel,
      toValue: targetValue,
      toLabel: null,
    };
  }

  await navigation;

  if (await isLoginPage(page)) {
    await ctx.ensureLoggedIn(page, { reason: "queue-page-advance" });
    await ensureManuscriptListReady(page, queueLabel);

    const afterLogin = await readQueuePageInfo(page);
    if (retryAfterLogin && afterLogin?.selectedValue !== targetValue) {
      return goToQueueListPage(page, targetValue, false, queueLabel);
    }
  }

  const after = await readQueuePageInfo(page);

  return {
    changed: after?.selectedValue === targetValue,
    reason: after?.selectedValue === targetValue ? null : "Server did not return the requested queue page.",
    fromValue: before.selectedValue,
    fromLabel: before.selectedLabel,
    toValue: targetValue,
    toLabel: after?.selectedLabel || null,
  };
}

export async function openViewDetailsSelectByIndex(page, index) {
  const handles = await page.locator(REJECT_SELECTORS.queueAction).elementHandles();
  const matching = [];

  for (const handle of handles) {
    const hasViewDetails = await handle.evaluate((select) =>
      Array.from(select.options).some((option) => /view\s+details/i.test(option.textContent || ""))
    );
    if (hasViewDetails) {
      matching.push(handle);
    }
  }

  const handle = matching[index];
  if (!handle) {
    return false;
  }

  const optionValue = await handle.evaluate((select) => {
    const option = Array.from(select.options).find((candidate) =>
      /view\s+details/i.test(candidate.textContent || "")
    );
    return option ? option.value : null;
  });

  if (!optionValue) {
    throw new Error("View Details option not found");
  }

  const navigation = waitForNavigationOrTimeout(page, 12000);
  await handle.selectOption(optionValue).catch(async () => {
    await handle.evaluate((select, value) => {
      select.value = value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, optionValue);
  });
  await navigation;

  return true;
}

export async function openViewDetailsClickableByIndex(page, index) {
  const canClick = await page.evaluate((targetIndex) => {
    const elements = Array.from(
      document.querySelectorAll("a, button, input[type='button'], input[type='submit']")
    );
    const matches = elements.filter((element) => {
      const text = [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
      ]
        .filter(Boolean)
        .join(" ");
      return /view\s+details/i.test(text);
    });
    return Boolean(matches[targetIndex]);
  }, index);

  if (!canClick) {
    return false;
  }

  await Promise.all([
    waitForLikelyNavigation(page),
    page.evaluate((targetIndex) => {
      const elements = Array.from(
        document.querySelectorAll("a, button, input[type='button'], input[type='submit']")
      );
      const matches = elements.filter((element) => {
        const text = [
          element.textContent,
          element.getAttribute("value"),
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
        ]
          .filter(Boolean)
          .join(" ");
        return /view\s+details/i.test(text);
      });
      matches[targetIndex].click();
    }, index),
  ]);

  return true;
}

export async function waitForLikelyNavigation(page) {
  const beforeUrl = page.url();
  await Promise.race([
    page.waitForURL((url) => url.href !== beforeUrl, { timeout: 10000 }).catch(() => undefined),
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    page.waitForTimeout(2500),
  ]);
}

export async function waitForDetailsPage(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    const hasManuscriptId = /\b[A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?\b/i.test(text);
    const hasQueueSelect = Boolean(
      document.querySelector("select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']")
    );
    const loadedFlag = document.forms[0]?.elements?.PAGE_LOADED_FLAG;
    const formIsReady = !loadedFlag || loadedFlag.value !== "N";

    return formIsReady && hasManuscriptId && !hasQueueSelect;
  }, null, {
    timeout: 15000,
  });
}

export async function waitForDetailsPageOrRelogin(page, reason) {
  try {
    await waitForDetailsPage(page);
    return true;
  } catch (error) {
    if (await isLoginPage(page)) {
      await ctx.log("login_detected_while_waiting_for_details", {
        reason,
        message: error.message,
        url: page.url(),
      });
      await ctx.ensureLoggedIn(page, { reason });
      return false;
    }

    throw error;
  }
}

export async function inspectCurrentManuscript(page) {
  const bodyText = await page.locator("body").innerText();
  return inspectManuscriptText(bodyText, {
    submittedOlderThanDays: ctx.config.submittedOlderThanDays,
  });
}

export async function returnToList(page) {
  if (await isLoginPage(page)) {
    await ctx.ensureLoggedIn(page, { reason: "return-to-list" });
    await page.goto(ctx.config.startUrl, { waitUntil: "domcontentloaded" });
    await ensureManuscriptListReady(page);
    return;
  }

  const before = page.url();
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  if (await isLoginPage(page)) {
    await ctx.ensureLoggedIn(page, { reason: "return-to-list-after-back" });
    await page.goto(ctx.config.startUrl, { waitUntil: "domcontentloaded" });
    await ensureManuscriptListReady(page);
    return;
  }

  if (page.url() !== before && (await countViewDetailsControls(page)) > 0) {
    return;
  }

  const backControls = [
    page.getByRole("link", { name: /back|return|manuscript list|dashboard/i }),
    page.getByRole("button", { name: /back|return|manuscript list|dashboard/i }),
  ];

  for (const locator of backControls) {
    if ((await locator.count().catch(() => 0)) > 0) {
      await Promise.all([
        waitForLikelyNavigation(page),
        locator.first().click(),
      ]);
      return;
    }
  }

  await page.goto(ctx.config.startUrl, { waitUntil: "domcontentloaded" });
  await ctx.ensureLoggedIn(page, { reason: "return-to-list-start-url" });
  await ensureManuscriptListReady(page);
}

export async function goToNextDocument(page) {
  if (await isLoginPage(page)) {
    await ctx.ensureLoggedIn(page, { reason: "before-next-document" });
    return false;
  }

  const submitted = await submitScholarOneLinkByImageAlt(page, /next\s+document|next_mss\.gif/i);
  if (!submitted) {
    return false;
  }

  const detailsReady = await waitForDetailsPageOrRelogin(page, "next-document");
  if (!detailsReady) {
    await ctx.log("next_document_wait_failed", {
      message: "Login detected while waiting for next details page.",
      url: page.url(),
    });
    return false;
  }

  return true;
}

export async function ensureManuscriptListReady(page, queueLabel = ctx.config.assessmentQueueLabel || "Complete Checklist") {
  await page.waitForLoadState("domcontentloaded");
  await dismissCookieBanner(page);

  if (await isAdminQueueEmpty(page, queueLabel) ||
      ((await countViewDetailsControls(page)) > 0 && await isCurrentAdminQueue(page, queueLabel))) {
    return;
  }

  if (await isLoginPage(page)) {
    await ctx.ensureLoggedIn(page, { reason: "queue" });
    if (await isAdminQueueEmpty(page, queueLabel) ||
        ((await countViewDetailsControls(page)) > 0 && await isCurrentAdminQueue(page, queueLabel))) {
      return;
    }
  }

  const navigated = await navigateToAdminQueue(page, queueLabel);
  if (navigated && ((await countViewDetailsControls(page)) > 0 || await isAdminQueueEmpty(page, queueLabel))) {
    return;
  }

  throw new Error(
    `Nie widze kontrolek 'View Details'. Skrypt probowal przejsc przez Manage -> Admin Center -> ${queueLabel}. Jesli layout jest inny, uruchom codegen albo podeślij screenshot Admin Center.`
  );
}
