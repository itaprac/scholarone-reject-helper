// Kroki wysyłki maila odrzucającego. Najbardziej nieodwracalna ścieżka w
// projekcie: po kliknięciu Save and Send autor dostaje wiadomość.
import { REJECT_SELECTORS } from "../selectors/reject.js";
import { TIMEOUTS } from "../core/timeouts.js";

export async function clickRejectAndFillEmail(page, message) {
  const existingPages = new Set(page.context().pages());
  const newPagePromise = page.context().waitForEvent("page", { timeout: 25000 }).catch(() => null);
  const rejectSubmitResult = await submitRejectDecision(page);

  if (!rejectSubmitResult.submitted) {
    return {
      clicked: false,
      dialogMessages: rejectSubmitResult.dialogMessages || [],
      emailBodyFilled: false,
      rejectSubmitResult,
      note: rejectSubmitResult.note || "Reject control was not found.",
      emailPage: null,
    };
  }

  await Promise.race([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    page.waitForTimeout(3000),
  ]);

  let emailPage = null;
  try {
    emailPage = await waitForEmailPopupPage(page.context(), page, newPagePromise, existingPages);
  } catch (error) {
    return {
      clicked: true,
      dialogMessages: rejectSubmitResult.dialogMessages || [],
      rejectSubmitResult,
      emailBodyFilled: false,
      note: error.message,
      emailPage: null,
    };
  }

  const emailResult = await fillRejectEmailBody(emailPage, message);

  return {
    clicked: true,
    dialogMessages: rejectSubmitResult.dialogMessages || [],
    rejectSubmitResult,
    ...emailResult,
    emailPage,
  };
}

export async function submitRejectDecision(page) {
  let result = null;

  try {
    result = await page.evaluate(() => {
      const form = document.forms[0];
      if (!form) {
        return {
          submitted: false,
          note: "No form found on checklist page.",
        };
      }

      const link = findRejectLink();
      if (!link) {
        return {
          submitted: false,
          note: "Reject link was not found in DOM.",
        };
      }

      const hrefScript = normalizeScript(link.getAttribute("href") || "");
      const onclickScript = normalizeScript(link.getAttribute("onclick") || "");
      const combinedScript = `${hrefScript};${onclickScript}`;
      const dialogMessages = [];
      const confirmMessage = extractConfirmMessage(onclickScript);
      if (confirmMessage) {
        dialogMessages.push(confirmMessage);
      }

      const fieldsSet = [];
      for (const match of combinedScript.matchAll(/setField\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\)/g)) {
        setFormValue(match[1], decodeHtml(match[2]));
        fieldsSet.push(match[1]);
      }

      const nextPage = hrefScript.match(/setNextPage\(['"]([^'"]+)['"]\)/)?.[1] || "MANUSCRIPT_DETAILS";
      setFormValue("NEXT_PAGE", nextPage);
      fieldsSet.push("NEXT_PAGE");

      if (window.getPostParams) {
        window.getPostParams();
      }

      form.target = "";
      if (window.showHourGlass) {
        window.showHourGlass();
      }
      HTMLFormElement.prototype.submit.call(form);

      return {
        submitted: true,
        method: "dom-form-submit",
        dialogMessages,
        fieldsSet,
        nextPage,
        linkLabel: linkLabel(link).slice(0, 240),
      };

      function findRejectLink() {
        const links = Array.from(document.querySelectorAll("a"));
        const candidates = links
          .map((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const ownLabel = [
              candidate.textContent,
              candidate.getAttribute("value"),
              candidate.getAttribute("title"),
              candidate.getAttribute("aria-label"),
              candidate.getAttribute("alt"),
            ]
              .filter(Boolean)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            const actionScript = [
              candidate.getAttribute("href"),
              candidate.getAttribute("onclick"),
            ]
              .filter(Boolean)
              .join(";");
            const directImageLabels = Array.from(candidate.children)
              .filter((child) => child.tagName === "IMG")
              .map((image) => [image.getAttribute("alt"), image.getAttribute("src")].filter(Boolean).join(" "))
              .join(" ");
            const exactLabel = /^reject$/i.test(ownLabel);
            const directRejectImage = /reject\.gif/i.test(directImageLabels);
            const immediateRejectAction = /immediately\s+reject/i.test(actionScript);
            const score = (immediateRejectAction ? 100 : 0) + (exactLabel ? 10 : 0) + (directRejectImage ? 5 : 0);
            return { candidate, rect, score };
          })
          .filter(({ rect, score }) => rect.width > 0 && rect.height > 0 && score > 0)
          .sort((left, right) => right.score - left.score);

        return candidates[0]?.candidate || null;
      }

      function linkLabel(link) {
        return [
          link.textContent,
          link.getAttribute("value"),
          link.getAttribute("title"),
          link.getAttribute("aria-label"),
          link.getAttribute("alt"),
          link.getAttribute("href"),
          link.getAttribute("onclick"),
          Array.from(link.querySelectorAll("img"))
            .map((image) => [image.getAttribute("alt"), image.getAttribute("src")].filter(Boolean).join(" "))
            .join(" "),
        ]
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }

      function normalizeScript(script) {
        return script.replace(/^javascript:/i, "");
      }

      function extractConfirmMessage(script) {
        const match = script.match(/confirm\((['"])([\s\S]*?)\1\)/);
        return match ? decodeHtml(match[2]) : null;
      }

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

      function decodeHtml(value) {
        const textarea = document.createElement("textarea");
        textarea.innerHTML = value;
        return textarea.value;
      }
    });
  } catch (error) {
    if (/execution context|navigation|destroyed/i.test(error.message || "")) {
      return {
        submitted: true,
        method: "dom-form-submit",
        dialogMessages: [],
        note: "Form submission triggered navigation before diagnostics were returned.",
      };
    }

    throw error;
  }

  return result || {
    submitted: false,
    note: "Reject submission returned no result.",
  };
}

export async function waitForEmailPopupPage(context, fallbackPage, newPagePromise, existingPages) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const emailPage = await findEmailPopupPage(context.pages(), fallbackPage, existingPages);
    if (emailPage) {
      return emailPage;
    }

    const newPage = await Promise.race([
      newPagePromise,
      fallbackPage.waitForTimeout(500).then(() => null),
    ]);

    if (newPage && await pageHasEmailBody(newPage)) {
      return newPage;
    }
  }

  if (await pageHasEmailBody(fallbackPage)) {
    return fallbackPage;
  }

  throw new Error("Reject clicked, but email popup with EMAIL_TEMPLATE_BODY was not found.");
}

export async function findEmailPopupPage(pages, fallbackPage, existingPages) {
  for (const candidate of pages) {
    if (candidate !== fallbackPage && existingPages.has(candidate)) {
      continue;
    }

    if (await pageHasEmailBody(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function pageHasEmailBody(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => undefined);

  for (const frame of page.frames()) {
    const count = await frame.locator(REJECT_SELECTORS.emailBody).count().catch(() => 0);
    if (count > 0) {
      return true;
    }
  }

  return false;
}

export async function fillRejectEmailBody(emailPage, message) {
  const frame = await waitForEmailBodyFrame(emailPage);
  const bodyLocator = frame.locator(REJECT_SELECTORS.emailBody).first();

  await bodyLocator.fill(message);
  await bodyLocator.evaluate((element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  });

  const filledValue = await bodyLocator.inputValue();

  return {
    emailBodyFilled: filledValue === message,
    emailBodyLength: filledValue.length,
    expectedEmailBodyLength: message.length,
    emailFrameName: frame.name() || null,
    emailPageUrl: emailPage.url(),
    saveAndSendControlsFound: await countSaveAndSendControls(emailPage),
    note: "Reject was clicked and email body was replaced. Save and Send is handled in the next step when enabled.",
  };
}

export async function clickSaveAndSend(emailPage, openerPage) {
  if (!emailPage || emailPage.isClosed()) {
    return {
      clicked: false,
      sent: false,
      emailPageClosed: true,
      note: "Email popup is already closed before Save and Send.",
    };
  }

  const dialogMessages = [];
  const dialogHandler = async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.accept().catch(() => undefined);
  };

  emailPage.on("dialog", dialogHandler);

  try {
    const target = await findSaveAndSendControl(emailPage, { timeout: TIMEOUTS.slowElement });
    if (!target) {
      return {
        clicked: false,
        sent: false,
        emailPageClosed: false,
        dialogMessages,
        note: "Save and Send control was not found.",
      };
    }

    const closePromise = emailPage.waitForEvent("close", { timeout: 30000 })
      .then(() => true)
      .catch(() => false);

    await target.locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await target.locator.click({ timeout: 10000 });

    const popupClosed = await closePromise;
    if (!popupClosed) {
      const stillHasEmailBody = await pageHasEmailBody(emailPage).catch(() => false);
      return {
        clicked: true,
        sent: false,
        emailPageClosed: false,
        stillHasEmailBody,
        dialogMessages,
        saveAndSendFrameName: target.frameName,
        note: "Save and Send was clicked, but the email popup did not close within the timeout.",
      };
    }

    await openerPage.bringToFront().catch(() => undefined);
    await Promise.race([
      openerPage.waitForLoadState("domcontentloaded").catch(() => undefined),
      openerPage.waitForTimeout(3000),
    ]);

    return {
      clicked: true,
      sent: true,
      emailPageClosed: true,
      dialogMessages,
      saveAndSendFrameName: target.frameName,
      openerUrl: openerPage.url(),
      note: "Save and Send clicked and popup closed.",
    };
  } finally {
    emailPage.off("dialog", dialogHandler);
  }
}

export async function findSaveAndSendControl(emailPage, { timeout = 0 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    if (emailPage.isClosed()) return null;
    for (const frame of emailPage.frames()) {
      const locators = [
        frame.locator(`${REJECT_SELECTORS.saveAndSendButton}:visible`).first(),
        frame.locator("a:visible").filter({ has: frame.locator(REJECT_SELECTORS.saveAndSendImage) }).first(),
        frame.locator(`${REJECT_SELECTORS.saveAndSendImage}:visible`).first(),
      ];

      for (const locator of locators) {
        if (await locator.isVisible().catch(() => false)) {
          return {
            locator,
            frameName: frame.name() || null,
          };
        }
      }
    }
    if (Date.now() >= deadline) break;
    await emailPage.waitForTimeout(Math.min(100, deadline - Date.now())).catch(() => undefined);
  } while (Date.now() < deadline);

  return null;
}

export async function waitForEmailBodyFrame(page) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 1000 }).catch(() => undefined);

    for (const frame of page.frames()) {
      const count = await frame.locator(REJECT_SELECTORS.emailBody).count().catch(() => 0);
      if (count > 0) {
        return frame;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error("Email body textarea EMAIL_TEMPLATE_BODY was not found.");
}

export async function countSaveAndSendControls(page) {
  let total = 0;

  for (const frame of page.frames()) {
    const count = await frame.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll("a, button, input[type='button'], input[type='submit'], img")
      );
      return elements.filter((element) => {
        const label = [
          element.textContent,
          element.getAttribute("value"),
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
          element.getAttribute("src"),
          element.getAttribute("id"),
          element.getAttribute("href"),
        ]
          .filter(Boolean)
          .join(" ");
        return /save\s*(and|&)?\s*send|save_send\.gif|emailPopupSaveButton/i.test(label);
      }).length;
    }).catch(() => 0);

    total += count;
  }

  return total;
}

export async function submitScholarOneLinkByImageAlt(page, pattern) {
  let submitted = false;
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: TIMEOUTS.navigation,
  }).then(() => null).catch((error) => error);
  try {
    submitted = await page.evaluate((source) => {
      const regex = new RegExp(source, "i");
      const form = document.forms[0];
      if (!form) {
        return false;
      }

      const images = Array.from(document.querySelectorAll("img"));
      const image = images.find((candidate) => {
        const label = [
          candidate.getAttribute("alt"),
          candidate.getAttribute("title"),
          candidate.getAttribute("src"),
        ]
          .filter(Boolean)
          .join(" ");
        return regex.test(label);
      });

      const link = image?.closest("a");
      if (!link) {
        return false;
      }

      const script = [
        link.getAttribute("href") || "",
        link.getAttribute("onclick") || "",
      ]
        .join(";")
        .replace(/^javascript:/i, "");

      if (!/set(DataAndNextPage|Field|NextPage)/i.test(script)) {
        return false;
      }

      for (const match of script.matchAll(/setField\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\)/g)) {
        setFormValue(match[1], decodeHtml(match[2]));
      }

      const dataAndNext = script.match(
        /setDataAndNextPage\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]+)['"]\)/
      );
      if (dataAndNext) {
        setFormValue(dataAndNext[1], decodeHtml(dataAndNext[2]));
        setFormValue("NEXT_PAGE", dataAndNext[3]);
        submitForm(form);
        return true;
      }

      return false;

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

      function submitForm(targetForm) {
        if (targetForm.elements.PAGE_LOADED_FLAG) {
          targetForm.elements.PAGE_LOADED_FLAG.value = "N";
        }
        if (window.getPostParams) {
          window.getPostParams();
        }
        targetForm.target = "";
        HTMLFormElement.prototype.submit.call(targetForm);
      }

      function decodeHtml(value) {
        const textarea = document.createElement("textarea");
        textarea.innerHTML = value;
        return textarea.value;
      }
    }, pattern.source);
  } catch (error) {
    submitted = /execution context|navigation|destroyed/i.test(error.message || "");
  }

  if (!submitted) {
    return false;
  }

  const navigationError = await navigation;
  if (navigationError) throw navigationError;
  return true;
}

export async function countRejectControls(page) {
  return page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll("a, button, input[type='button'], input[type='submit'], img")
    );
    return elements.filter(isActualRejectControl).length;

    function isActualRejectControl(element) {
      if (!isVisible(element)) {
        return false;
      }

      const ownLabel = [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const ownSrc = element.getAttribute("src") || "";
      const onclick = element.getAttribute("onclick") || "";
      const childImageLabels = Array.from(element.querySelectorAll("img"))
        .map((image) => [image.getAttribute("alt"), image.getAttribute("src")].filter(Boolean).join(" "))
        .join(" ");

      return /^reject$/i.test(ownLabel) ||
        /reject\.gif/i.test(ownSrc) ||
        /reject\.gif/i.test(childImageLabels) ||
        /immediately\s+reject/i.test(onclick);
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }).catch(() => 0);
}
