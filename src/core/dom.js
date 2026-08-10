import { TIMEOUTS } from "./timeouts.js";

// ScholarOne renderuje menu i przyciski jako zwykłe <div>/<span> z onclick,
// często bez dostępnej nazwy. Dlatego zamiast getByRole szukamy po widocznym
// tekście, tytule, alt i aria-label naraz.
const CONTROL_SELECTOR =
  "a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li, div, span";
const CLICKABLE_SELECTOR =
  "a, button, input[type='button'], input[type='submit'], [onclick], [role='button'], li";
const MAX_LABEL_LENGTH = 160;

// Kliknięcie w link ScholarOne potrafi zniszczyć kontekst wykonania, zanim
// page.evaluate zdąży zwrócić wartość. To nie jest błąd — to znaczy, że
// nawigacja ruszyła, czyli dokładnie to, o co nam chodziło.
const NAVIGATION_RACE = /execution context|navigation|destroyed/i;

function isNavigationRace(error) {
  return NAVIGATION_RACE.test(error?.message || "");
}

export async function clickTextControl(page, pattern, { waitForNavigation = true } = {}) {
  let clicked = false;

  try {
    clicked = await page.evaluate(({ source, controlSelector, clickableSelector, maxLabel }) => {
      const regex = new RegExp(source, "i");

      const match = Array.from(document.querySelectorAll(controlSelector))
        .map((element) => ({
          element,
          text: readLabel(element),
          rect: element.getBoundingClientRect(),
        }))
        .filter(({ text, rect }) =>
          regex.test(text) && text.length <= maxLabel && rect.width > 0 && rect.height > 0
        )
        // Najkrótsza pasująca etykieta to zwykle sama kontrolka, a nie
        // kontener, który ją opakowuje.
        .sort((left, right) => left.text.length - right.text.length)[0]?.element;

      if (!match) return false;

      const control = match.closest(clickableSelector) || match;
      for (const type of ["mouseover", "mouseenter", "mousedown", "mouseup"]) {
        control.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
      control.click();
      return true;

      function readLabel(element) {
        return [
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
      }
    }, {
      source: pattern.source,
      controlSelector: CONTROL_SELECTOR,
      clickableSelector: CLICKABLE_SELECTOR,
      maxLabel: MAX_LABEL_LENGTH,
    });
  } catch (error) {
    clicked = isNavigationRace(error);
  }

  if (clicked && waitForNavigation) {
    await waitForNavigationOrTimeout(page, TIMEOUTS.navigation);
  }
  return clicked;
}

export async function hoverTextControl(page, pattern) {
  return page.evaluate(({ source, controlSelector, clickableSelector, maxLabel }) => {
    const regex = new RegExp(source, "i");

    const match = Array.from(document.querySelectorAll(controlSelector))
      .map((element) => ({
        element,
        text: [
          element.textContent,
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
        ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim(),
        rect: element.getBoundingClientRect(),
      }))
      .filter(({ text, rect }) =>
        regex.test(text) && text.length <= maxLabel && rect.width > 0 && rect.height > 0
      )
      .sort((left, right) => left.text.length - right.text.length)[0]?.element;

    if (!match) return false;

    const control = match.closest(clickableSelector) || match;
    for (const type of ["mouseover", "mouseenter", "mousemove"]) {
      control.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    return true;
  }, {
    source: pattern.source,
    controlSelector: CONTROL_SELECTOR,
    clickableSelector: CLICKABLE_SELECTOR,
    maxLabel: MAX_LABEL_LENGTH,
  }).catch(() => false);
}

export async function hasVisibleTextControl(page, pattern) {
  return page.evaluate(({ source, controlSelector, maxLabel }) => {
    const regex = new RegExp(source, "i");

    return Array.from(document.querySelectorAll(controlSelector)).some((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;

      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }

      const text = [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

      return text.length <= maxLabel && regex.test(text);
    });
  }, {
    source: pattern.source,
    controlSelector: CONTROL_SELECTOR,
    maxLabel: MAX_LABEL_LENGTH,
  }).catch(() => false);
}

// Odpytywanie warunku aż do skutku. ScholarOne rzadko daje zdarzenie, na które
// dałoby się poczekać wprost, więc pętla z warunkiem jest tu regułą, a nie
// obejściem — w odróżnieniu od gołego uśpienia na sztywną liczbę milisekund.
export async function waitForCondition(page, predicate, {
  timeout = TIMEOUTS.element,
  interval = 250,
} = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(interval).catch(() => undefined);
  }
}

export async function waitForVisibleTextControl(page, pattern, timeout = TIMEOUTS.element) {
  return waitForCondition(page, () => hasVisibleTextControl(page, pattern), {
    timeout,
    interval: 200,
  });
}

export async function findHrefByText(page, pattern) {
  return page.evaluate((source) => {
    const regex = new RegExp(source, "i");

    const match = Array.from(document.querySelectorAll("a[href]")).find((link) =>
      [link.textContent, link.getAttribute("title"), link.getAttribute("aria-label")]
        .filter(Boolean)
        .map((value) => value.replace(/\s+/g, " ").trim())
        .some((text) => regex.test(text))
    );

    if (!match) return null;

    const href = match.getAttribute("href");
    if (!href || /^javascript:/i.test(href) || href === "#") return null;

    return new URL(href, window.location.href).href;
  }, pattern.source).catch(() => null);
}

export async function activateLinkByText(page, pattern) {
  const navigation = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation })
    .then(() => true)
    .catch(() => false);

  let activated = false;
  try {
    activated = await page.evaluate((source) => {
      const regex = new RegExp(source, "i");

      const match = Array.from(document.querySelectorAll("a"))
        .map((link) => {
          const labels = [link.textContent, link.getAttribute("title"), link.getAttribute("aria-label")]
            .filter(Boolean)
            .map((value) => value.replace(/\s+/g, " ").trim());
          return {
            link,
            text: labels.filter((text) => regex.test(text)).sort((a, b) => a.length - b.length)[0] || "",
          };
        })
        .filter(({ text }) => text)
        .sort((left, right) => left.text.length - right.text.length)[0]?.link;

      if (!match) return false;

      const href = match.getAttribute("href") || "";
      if (/^javascript:/i.test(href)) {
        Function(href.replace(/^javascript:/i, "")).call(window);
        return true;
      }

      match.click();
      return true;
    }, pattern.source);
  } catch (error) {
    activated = isNavigationRace(error);
  }

  if (!activated) return false;

  await Promise.race([
    navigation,
    page.waitForTimeout(TIMEOUTS.navigation).then(() => false),
  ]);
  return true;
}

// ScholarOne nie nawiguje linkami — linki wywołują setDataAndNextPage(...) i
// wysyłają jeden globalny formularz. Odtwarzamy to zachowanie zamiast klikać,
// bo kliknięcie bywa przechwycone przez nakładki i skrypty strony.
export async function submitScholarOneLinkByText(page, pattern, scriptPattern = null) {
  let submitted = false;

  try {
    submitted = await page.evaluate(({ source, scriptSource }) => {
      const regex = new RegExp(source, "i");
      const scriptRegex = scriptSource ? new RegExp(scriptSource, "i") : null;
      const form = document.forms[0];
      if (!form) return false;

      const link = Array.from(document.querySelectorAll("a"))
        .map((candidate) => {
          const labels = [
            candidate.textContent,
            candidate.getAttribute("title"),
            candidate.getAttribute("aria-label"),
          ].filter(Boolean).map((value) => value.replace(/\s+/g, " ").trim());

          return {
            link: candidate,
            text: labels.filter((text) => regex.test(text)).sort((a, b) => a.length - b.length)[0] || "",
            script: readScript(candidate),
          };
        })
        .filter(({ text, script }) => text && (!scriptRegex || scriptRegex.test(script)))
        .sort((left, right) => left.text.length - right.text.length)[0]?.link;

      if (!link) return false;

      const script = readScript(link);
      if (!/set(DataAndNextPage|Field|NextPage)/i.test(script)) return false;

      for (const match of script.matchAll(/setField\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\)/g)) {
        setFormValue(match[1], decodeHtml(match[2]));
      }

      const oneData = script.match(
        /setDataAndNextPageOneDataValue\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]+)['"]\)/
      );
      if (oneData) return applyAndSubmit(oneData[1], oneData[2], oneData[3]);

      const dataAndNext = script.match(
        /setDataAndNextPage\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]+)['"]\)/
      );
      if (dataAndNext) return applyAndSubmit(dataAndNext[1], dataAndNext[2], dataAndNext[3]);

      const next = script.match(/setNextPage\(['"]([^'"]+)['"]\)/);
      if (next) {
        setFormValue("NEXT_PAGE", next[1]);
        submitForm(form);
        return true;
      }

      return false;

      function applyAndSubmit(field, value, nextPage) {
        setFormValue(field, decodeHtml(value));
        setFormValue("NEXT_PAGE", nextPage);
        submitForm(form);
        return true;
      }

      function readScript(element) {
        return [element.getAttribute("href") || "", element.getAttribute("onclick") || ""]
          .join(";")
          .replace(/^javascript:/i, "");
      }

      function setFormValue(name, value) {
        let field = form.elements[name];
        // Kolekcja pól o tej samej nazwie nie ma tagName — bierzemy pierwsze.
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
        // Formularze ScholarOne mają pole o nazwie "submit", które przesłania
        // metodę — dlatego wołamy ją przez prototyp.
        HTMLFormElement.prototype.submit.call(targetForm);
      }

      function decodeHtml(value) {
        const textarea = document.createElement("textarea");
        textarea.innerHTML = value;
        return textarea.value;
      }
    }, {
      source: pattern.source,
      scriptSource: scriptPattern ? scriptPattern.source : "",
    });
  } catch (error) {
    submitted = isNavigationRace(error);
  }

  if (!submitted) return false;

  await Promise.race([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    page.waitForTimeout(TIMEOUTS.navigation),
  ]);
  return true;
}

export async function waitForNavigationOrTimeout(page, timeout = TIMEOUTS.navigation) {
  return Promise.race([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).then(() => true).catch(() => false),
    page.waitForTimeout(timeout).then(() => false),
  ]);
}

// Po nawigacji stary uchwyt kontekstu jest już nieważny. Powtórzenie evaluate na
// świeżym dokumencie jest tańsze niż rozstrzyganie, czy nawigacja właśnie trwa.
export async function evaluateAfterNavigation(page, pageFunction, argument) {
  try {
    return await page.evaluate(pageFunction, argument);
  } catch (error) {
    if (!isNavigationRace(error)) throw error;
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    return page.evaluate(pageFunction, argument);
  }
}
