import {
  clickSaveAndSend,
  fillRejectEmailBody,
  pageHasEmailBody,
} from "./steps/reject-email.js";
import { submitScholarOneLinkByText, waitForCondition } from "./core/dom.js";
import { TIMEOUTS } from "./core/timeouts.js";

const IMMEDIATE_DECISION_PATTERN = /^Immediate\s+Decision$/i;

export async function inspectImmediateDecision(page) {
  return page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll(
      "input[type='radio'][name$='_XIK_TASK_REC_DEC_ID']"
    )).map((radio) => ({
      name: radio.getAttribute("name"),
      value: radio.value,
      checked: radio.checked,
      label: readDecisionLabel(radio),
    }));
    const reject = radios.filter((entry) => /^Reject\s*-\s*Fatally\s+Flawed$/i.test(entry.label));
    const draftButtons = visibleCount("a[id^='createDraftEmailBtn_']");
    const commitButtons = visibleCount("a#CommitDecision");

    return {
      radios,
      reject,
      draftButtons,
      commitButtons,
    };

    function readDecisionLabel(radio) {
      const row = radio.closest("tr");
      if (row) {
        const clone = row.cloneNode(true);
        clone.querySelectorAll("script, style").forEach((node) => node.remove());
        return clean(clone.textContent);
      }
      const label = radio.id ? document.querySelector(`label[for=${JSON.stringify(radio.id)}]`) : null;
      return clean(label?.textContent);
    }

    function visibleCount(selector) {
      return Array.from(document.querySelectorAll(selector)).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 &&
          style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      }).length;
    }

    function clean(value) {
      return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
  });
}

export async function openImmediateDecision(page) {
  const alreadyReady = await inspectImmediateDecision(page);
  if (alreadyReady.reject.length === 1 && alreadyReady.commitButtons === 1) {
    return alreadyReady;
  }

  const opened = await submitScholarOneLinkByText(
    page,
    IMMEDIATE_DECISION_PATTERN,
    /MANUSCRIPT_DETAILS_SHOW_TAB/i
  );
  if (!opened) {
    throw new Error("Nie znaleziono zakładki Immediate Decision po przypisaniu EIC i AE.");
  }

  const ready = await waitForCondition(page, async () => {
    const inspection = await inspectImmediateDecision(page);
    return inspection.reject.length === 1 && inspection.commitButtons === 1;
  }, { timeout: TIMEOUTS.navigation });
  if (!ready) {
    throw new Error("Immediate Decision otworzyło się bez jednoznacznej decyzji Reject.");
  }
  return inspectImmediateDecision(page);
}

export async function selectImmediateReject(page) {
  const inspection = await inspectImmediateDecision(page);
  if (inspection.reject.length !== 1) {
    throw new Error(`Oczekiwano jednej decyzji Reject - Fatally Flawed, znaleziono ${inspection.reject.length}.`);
  }
  if (inspection.draftButtons !== 1 || inspection.commitButtons !== 1) {
    throw new Error(
      `Immediate Decision nie jest jednoznaczne: Create Draft ${inspection.draftButtons}, Commit ${inspection.commitButtons}.`
    );
  }

  const reject = inspection.reject[0];
  const radio = page.locator(
    `input[type='radio'][name=${JSON.stringify(reject.name)}][value=${JSON.stringify(reject.value)}]`
  );
  if (await radio.count() !== 1) {
    throw new Error("Pole Reject - Fatally Flawed przestało być jednoznaczne.");
  }
  await radio.check();
  if (!await radio.isChecked()) {
    throw new Error("Nie udało się wybrać Reject - Fatally Flawed.");
  }
  return { selected: true, label: reject.label };
}

export async function createAndSaveDecisionDraft(page, message) {
  const existingPages = new Set(page.context().pages());
  const newPagePromise = page.context().waitForEvent("page", { timeout: 25_000 }).catch(() => null);
  const draft = page.locator("a[id^='createDraftEmailBtn_']");
  if (await visibleLocatorCount(draft) !== 1) {
    throw new Error("Przycisk Create Draft E-mail nie jest jednoznaczny.");
  }
  await draft.click();

  const emailPage = await waitForNewEmailPage(page, existingPages, newPagePromise);
  const filled = await fillRejectEmailBody(emailPage, message);
  if (!filled.emailBodyFilled) {
    throw new Error("Nie udało się zapisać pełnej treści maila drugiej oceny.");
  }
  const saved = await saveAndCloseDraft(emailPage, page);
  if (!saved.saved) throw new Error(saved.note);
  return { filled, saved };
}

export async function commitImmediateReject(page, message) {
  const newPagePromise = page.context().waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  const commit = page.locator("a#CommitDecision");
  if (await visibleLocatorCount(commit) !== 1) {
    throw new Error("Przycisk Commit Decision nie jest jednoznaczny.");
  }

  const dialogMessages = [];
  const dialogHandler = async (dialog) => {
    dialogMessages.push(dialog.message());
    await dialog.accept().catch(() => undefined);
  };
  page.on("dialog", dialogHandler);
  const beforeUrl = page.url();

  try {
    await commit.click();
    const possiblePopup = await Promise.race([
      newPagePromise,
      page.waitForTimeout(3000).then(() => null),
    ]);

    if (possiblePopup && await pageHasEmailBody(possiblePopup)) {
      const filled = await fillRejectEmailBody(possiblePopup, message);
      if (!filled.emailBodyFilled) {
        throw new Error("Końcowy popup decyzji nie zachował pełnej treści maila.");
      }
      const send = await clickSaveAndSend(possiblePopup, page);
      if (!send.sent) throw new Error(send.note || "Końcowy mail decyzji nie został wysłany.");
      return { committed: true, dialogMessages, finalEmail: { filled, send } };
    }

    await Promise.race([
      page.waitForLoadState("domcontentloaded").catch(() => undefined),
      page.waitForTimeout(3000),
    ]);
    const commitStillVisible = await visibleLocatorCount(page.locator("a#CommitDecision"));
    if (page.url() === beforeUrl && commitStillVisible > 0) {
      throw new Error("Commit Decision nie potwierdził przejścia do następnego stanu.");
    }
    return { committed: true, dialogMessages, finalEmail: null };
  } finally {
    page.off("dialog", dialogHandler);
  }
}

async function waitForNewEmailPage(opener, existingPages, newPagePromise) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of opener.context().pages()) {
      if (candidate !== opener && !existingPages.has(candidate) && await pageHasEmailBody(candidate)) {
        return candidate;
      }
    }
    const candidate = await Promise.race([
      newPagePromise,
      opener.waitForTimeout(400).then(() => null),
    ]);
    if (candidate && await pageHasEmailBody(candidate)) return candidate;
  }
  throw new Error("Create Draft E-mail nie otworzył edytora wiadomości.");
}

async function saveAndCloseDraft(emailPage, openerPage) {
  const candidates = [];
  for (const frame of emailPage.frames()) {
    const elements = frame.locator("a,button,input[type='button'],input[type='submit'],img");
    for (const locator of await elements.all()) {
      if (!await locator.isVisible().catch(() => false)) continue;
      const label = await locator.evaluate((element) => [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
        element.getAttribute("src"),
        element.getAttribute("id"),
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim());
      if (/save\s*(and|&)\s*close|save_close\.gif|emailPopupSaveButton/i.test(label) &&
          !/save\s*(and|&)\s*send|save_send\.gif/i.test(label)) {
        candidates.push({ locator, frameName: frame.name() || null });
      }
    }
  }
  if (candidates.length !== 1) {
    return {
      saved: false,
      note: `Oczekiwano jednego Save and Close, znaleziono ${candidates.length}.`,
    };
  }

  const closePromise = emailPage.waitForEvent("close", { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  await candidates[0].locator.click();
  const closed = await closePromise;
  if (!closed) {
    return { saved: false, note: "Save and Close nie zamknął popupu wiadomości." };
  }
  await openerPage.bringToFront().catch(() => undefined);
  return { saved: true, frameName: candidates[0].frameName };
}

async function visibleLocatorCount(locator) {
  let count = 0;
  for (const candidate of await locator.all()) {
    if (await candidate.isVisible().catch(() => false)) count += 1;
  }
  return count;
}
