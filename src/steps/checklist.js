// Otwarcie i rozpoznanie strony Complete Checklist.
import { clickTextControl, hasVisibleTextControl, submitScholarOneLinkByText } from "../core/dom.js";
import { REJECT_PATTERNS } from "../selectors/reject.js";
import { countRejectControls } from "./reject-email.js";

export async function clickCompleteChecklist(page) {
  const alreadyOnChecklist = await countRejectControls(page);
  if (alreadyOnChecklist > 0) {
    return {
      clicked: false,
      rejectControlsFound: alreadyOnChecklist,
      note: "Already on checklist screen; safety stop before Reject.",
    };
  }

  const clickedDetailsTab = await submitScholarOneLinkByText(
    page,
    /\bcomplete\s+checklist\b/i,
    /MANUSCRIPT_DETAILS_SHOW_TAB/i
  );

  if (clickedDetailsTab) {
    await waitForChecklistPage(page);
    return {
      clicked: true,
      rejectControlsFound: await countRejectControls(page),
      note: "Complete Checklist details tab opened; safety stop before Reject.",
    };
  }

  return {
    clicked: false,
    rejectControlsFound: await countRejectControls(page),
    note: "Candidate found, but Complete Checklist control was not found.",
  };
}

export async function waitForChecklistPage(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    const elements = Array.from(
      document.querySelectorAll("a, button, input[type='button'], input[type='submit'], img")
    );
    const hasRejectControl = elements.some(isActualRejectControl);

    return hasRejectControl || /admin\s+checklist/i.test(text);

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
  }, null, { timeout: 12000 }).catch(() => undefined);
}

export function isNoRejectControlChecklistResult(checklistResult) {
  return checklistResult &&
    Number(checklistResult.rejectControlsFound || 0) === 0 &&
    /complete\s+checklist|reject|candidate|not\s+found|already/i.test(checklistResult.note || "");
}
