export const SCREENING_SELECTORS = {
  abstractLink: "a.msdetailsbuttons",
  popupCurrentPage: "input[name='CURRENT_PAGE'][value='AUTHOR_PREVIEW_POPUP']",
};

const MANUSCRIPT_ID_PATTERN = /\b[A-Z][A-Z0-9]+-\d{2}-\d{3,6}(?:\.R\d+)?\b/i;

export function hasUnusualActivityAlert(bodyText) {
  return /high\s+rate\s+of\s+unusual\s+activity/i.test(bodyText || "");
}

export async function waitForManuscriptMetadataReady(page, timeout = 25_000) {
  await page.waitForFunction((idPatternSource) => {
    const idPattern = new RegExp(idPatternSource, "i");
    const hasHeaderId = Array.from(document.querySelectorAll("td.headerbg2 p.pagecontents b"))
      .some((element) => idPattern.test(element.textContent || ""));
    const hasAbstractLink = Array.from(document.querySelectorAll("a.msdetailsbuttons"))
      .some((element) => {
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const href = element.getAttribute("href") || "";
        return /^Abstract$/i.test(text) && /popWindow\(.+ms_preview/is.test(href);
      });
    return hasHeaderId && hasAbstractLink;
  }, MANUSCRIPT_ID_PATTERN.source, { timeout });
}

export async function readManuscriptSummary(page) {
  return page.evaluate((idPatternSource) => {
    const idPattern = new RegExp(idPatternSource, "i");
    const boldElements = Array.from(document.querySelectorAll("td.headerbg2 p.pagecontents b"));
    const idElement = boldElements.find((element) => idPattern.test(clean(element.textContent)));

    if (!idElement) {
      return {
        manuscriptId: null,
        title: null,
        reason: "Nie znaleziono nagłówka z Manuscript ID.",
      };
    }

    const manuscriptId = clean(idElement.textContent).match(idPattern)?.[0]?.toUpperCase() || null;
    const idRow = idElement.closest("tr");
    const summaryTable = idRow?.closest("table");
    const rows = summaryTable ? Array.from(summaryTable.rows) : [];
    const idRowIndex = rows.indexOf(idRow);
    const titleFromNextRow = idRowIndex >= 0
      ? clean(rows[idRowIndex + 1]?.querySelector("p.pagecontents")?.textContent)
      : "";

    const title = titleFromNextRow || Array.from(
      summaryTable?.querySelectorAll("p.pagecontents") || []
    )
      .map((element) => clean(element.textContent))
      .find((text) => text && !idPattern.test(text) && !/^(submitted|last updated|in review)\s*:/i.test(text)) || null;

    return {
      manuscriptId,
      title,
      reason: title ? null : "Nie znaleziono tytułu pod nagłówkiem manuskryptu.",
    };

    function clean(value) {
      return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
  }, MANUSCRIPT_ID_PATTERN.source);
}

export async function readAbstractFromPopup(popup) {
  return popup.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("p.pagecontents b"));
    const abstractLabel = labels.find((element) => /^\s*abstract\s*:\s*$/i.test(element.textContent || ""));
    const paragraph = abstractLabel?.closest("p.pagecontents");
    if (!paragraph) {
      return null;
    }

    const clone = paragraph.cloneNode(true);
    const clonedLabel = Array.from(clone.querySelectorAll("b"))
      .find((element) => /^\s*abstract\s*:\s*$/i.test(element.textContent || ""));
    clonedLabel?.remove();
    return (clone.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null;
  });
}

export async function openAndReadAbstract(page, { timeout = 15_000 } = {}) {
  const candidates = page.locator(SCREENING_SELECTORS.abstractLink).filter({ hasText: /^\s*Abstract\s*$/i });
  const visible = [];
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      visible.push(candidate);
    }
  }

  if (visible.length !== 1) {
    throw new Error(`Oczekiwano jednego widocznego linku Abstract, znaleziono ${visible.length}.`);
  }
  const abstractHref = await visible[0].getAttribute("href");
  if (!/popWindow\(.+ms_preview/is.test(abstractHref || "")) {
    throw new Error("Widoczny link Abstract nie wskazuje oczekiwanego popupu ms_preview.");
  }

  const context = page.context();
  const stalePopups = [];
  for (const candidate of context.pages()) {
    if (candidate === page || candidate.isClosed()) {
      continue;
    }
    if (await isAbstractPopup(candidate)) {
      stalePopups.push(candidate);
    }
  }
  await Promise.all(stalePopups.map((popup) => popup.close().catch(() => undefined)));

  const popupPromise = Promise.race([
    page.waitForEvent("popup", { timeout }).catch(() => null),
    waitForAbstractPopup(context, page, timeout),
  ]);
  await visible[0].click();
  const popup = await popupPromise;
  if (!popup) {
    throw new Error("Kliknięto Abstract, ale popup nie został odnaleziony.");
  }

  try {
    await popup.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
    await popup.locator(SCREENING_SELECTORS.popupCurrentPage).waitFor({ state: "attached", timeout })
      .catch(() => undefined);
    const abstract = await readAbstractFromPopup(popup);
    if (!abstract) {
      throw new Error("Popup został otwarty, ale nie udało się odczytać abstraktu.");
    }
    return abstract;
  } finally {
    await popup.close().catch(() => undefined);
  }
}

async function waitForAbstractPopup(context, parentPage, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const candidate of context.pages()) {
      if (candidate !== parentPage && !candidate.isClosed() && await isAbstractPopup(candidate)) {
        return candidate;
      }
    }
    await parentPage.waitForTimeout(200);
  }
  return null;
}

async function isAbstractPopup(page) {
  if (/AUTHOR_PREVIEW_POPUP/i.test(page.url())) {
    return true;
  }
  return await page.locator(SCREENING_SELECTORS.popupCurrentPage).count().catch(() => 0) > 0;
}
