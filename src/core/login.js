import { TIMEOUTS } from "./timeouts.js";

const MANUAL_LOGIN_TIMEOUT = 5 * 60 * 1000;

// Markery świadczące, że jesteśmy już w środku aplikacji, a nie na logowaniu.
const LOGGED_IN_TEXT =
  /log\s*out|admin\s+center|complete\s+checklist|view\s+details|manuscripts\s+\d+\s*-\s*\d+\s+of/i;

export async function isLoginPage(page) {
  return page.evaluate((loggedInSource) => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    // Widoczne pole hasła obok markera zalogowania zdarza się na ekranie zmiany
    // hasła — tam nie chcemy uruchamiać auto-loginu.
    if (new RegExp(loggedInSource, "i").test(text)) return false;

    if (Array.from(document.querySelectorAll("input[type='password']")).some(isVisible)) {
      return true;
    }

    const usernameInput = Array.from(document.querySelectorAll("input")).some((input) =>
      isVisible(input) &&
      /user\s*name|username|user\s*id|email|login/i.test(
        [input.name, input.id, input.placeholder, input.getAttribute("aria-label")]
          .filter(Boolean).join(" ")
      )
    );

    const loginControl = Array.from(
      document.querySelectorAll("button, input[type='button'], input[type='submit'], input[type='image'], a")
    ).some((element) =>
      isVisible(element) &&
      /log\s*in|sign\s*in/i.test(
        [element.textContent, element.getAttribute("value"), element.getAttribute("title"), element.getAttribute("aria-label")]
          .filter(Boolean).join(" ")
      )
    );

    return usernameInput && loginControl;

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }, LOGGED_IN_TEXT.source).catch(() => false);
}

// Zwraca true, jeśli trzeba było się logować. Zależności są wstrzykiwane, bo ta
// sama procedura obsługuje przebiegi odrzucania i wyboru recenzentów, które mają
// osobne loggery i osobną politykę zrzutów ekranu.
export async function ensureLoggedIn(page, {
  credentials = {},
  autoLogin = false,
  reason = "unknown",
  log = async () => undefined,
  screenshots = null,
  detectLoginPage = isLoginPage,
} = {}) {
  if (!(await detectLoginPage(page))) return false;

  if (autoLogin && credentials.username && credentials.password) {
    console.log("Sesja wygasła. Próbuję zalogować automatycznie...");
    await log("auto_login_started", { reason, url: page.url() });

    const result = await performAutoLogin(page, credentials, { detectLoginPage });
    await log("auto_login_attempted", { reason, ...result });

    if (result.loginMarkersFound || !(await detectLoginPage(page))) {
      console.log("Auto-login OK, kontynuuję.");
      await log("auto_login_succeeded", { reason, url: page.url() });
      return true;
    }

    const screenshot = await screenshots?.error(page, `auto-login-failed-${reason}`);
    await log("auto_login_failed", { reason, url: page.url(), screenshot });
    console.log(`Auto-login nie przeszedł.${screenshot ? ` Screenshot: ${screenshot}` : ""}`);
    console.log("Zaloguj się ręcznie w otwartym oknie; skrypt poczeka.");
  } else {
    console.log("Trzeba się zalogować. Zaloguj się ręcznie w otwartym oknie; skrypt poczeka.");
  }

  await waitForManualLogin(page);
  return true;
}

export async function waitForManualLogin(page, timeout = MANUAL_LOGIN_TIMEOUT) {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    if (/view\s+details|log\s*out|manage|admin\s+center/i.test(text)) return true;

    return Array.from(document.querySelectorAll(
      "select option, a, button, input[type='button'], input[type='submit'], input[type='image']"
    )).some((element) =>
      /view\s+details/i.test(
        [
          element.textContent,
          element.getAttribute("value"),
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.getAttribute("alt"),
        ].filter(Boolean).join(" ")
      )
    );
  }, null, { timeout });
}

export async function performAutoLogin(page, credentials, { detectLoginPage = isLoginPage } = {}) {
  // Najpierw znane identyfikatory ScholarOne — są stabilne i pozwalają użyć
  // prawdziwych kliknięć Playwrighta zamiast syntetycznych zdarzeń.
  const known = await performScholarOneAutoLogin(page, credentials, { detectLoginPage });
  if (known.usedKnownSelectors) return known;

  const result = await page.evaluate(({ username, password }) => {
    const passwordInput = Array.from(document.querySelectorAll("input[type='password']")).find(isVisible);
    if (!passwordInput) {
      return { filledUsername: false, filledPassword: false, clickedLogin: false, note: "Brak widocznego pola hasła." };
    }

    const usernameInput = findUsernameInput(passwordInput);
    if (!usernameInput) {
      return { filledUsername: false, filledPassword: false, clickedLogin: false, note: "Brak widocznego pola loginu." };
    }

    setInputValue(usernameInput, username);
    setInputValue(passwordInput, password);

    const loginControl = findLoginControl(passwordInput.form);
    if (loginControl) {
      for (const type of ["mouseover", "mouseenter", "mousedown", "mouseup"]) {
        loginControl.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
      loginControl.click();
    } else if (passwordInput.form) {
      HTMLFormElement.prototype.submit.call(passwordInput.form);
    }

    return {
      filledUsername: true,
      filledPassword: true,
      clickedLogin: Boolean(loginControl),
      submittedFormDirectly: !loginControl && Boolean(passwordInput.form),
      loginControlLabel: loginControl ? elementLabel(loginControl).slice(0, 120) : null,
      usernameInputName: usernameInput.name || usernameInput.id || null,
      passwordInputName: passwordInput.name || passwordInput.id || null,
      loginControlTag: loginControl ? loginControl.tagName : null,
    };

    function findUsernameInput(referencePasswordInput) {
      const inputs = Array.from(document.querySelectorAll("input")).filter(
        (input) => isVisible(input) && !/^(hidden|password|submit|button|checkbox|radio)$/i.test(input.type || "")
      );

      const labeled = inputs.find((input) =>
        /user\s*name|username|user\s*id|email|login/i.test(
          [input.name, input.id, input.placeholder, input.getAttribute("aria-label"), input.getAttribute("title")]
            .filter(Boolean).join(" ")
        )
      );
      if (labeled) return labeled;

      // Bez etykiety: ostatnie pole tekstowe przed polem hasła.
      const beforePassword = inputs.filter(
        (input) => input.compareDocumentPosition(referencePasswordInput) & Node.DOCUMENT_POSITION_FOLLOWING
      );
      return beforePassword.at(-1) || inputs[0] || null;
    }

    function findLoginControl(form) {
      const controls = Array.from(
        document.querySelectorAll("button, input[type='button'], input[type='submit'], input[type='image'], a")
      ).filter(isVisible);

      const labeled = controls.find((control) => /log\s*in|sign\s*in|submit|continue/i.test(elementLabel(control)));
      if (labeled) return labeled;

      if (form) {
        return Array.from(
          form.querySelectorAll("button, input[type='button'], input[type='submit'], input[type='image']")
        ).find(isVisible) || null;
      }
      return null;
    }

    function setInputValue(input, value) {
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function elementLabel(element) {
      return [
        element.textContent,
        element.getAttribute("value"),
        element.getAttribute("title"),
        element.getAttribute("aria-label"),
        element.getAttribute("alt"),
      ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }, credentials).catch((error) => ({
    filledUsername: false,
    filledPassword: false,
    clickedLogin: false,
    note: error.message,
  }));

  let pressedEnterFallback = false;
  let loggedIn = await waitForLoggedIn(page, TIMEOUTS.navigation);
  if (!loggedIn && result.filledPassword) {
    pressedEnterFallback = true;
    await page.keyboard.press("Enter").catch(() => undefined);
    loggedIn = await waitForLoggedIn(page, TIMEOUTS.slowElement);
  }

  const stillOnLoginPage = !loggedIn && (await detectLoginPage(page));
  return {
    ...result,
    pressedEnterFallback,
    loginMarkersFound: loggedIn,
    stillOnLoginPage,
    loginFailureText: stillOnLoginPage ? await readLoginFailureText(page) : null,
  };
}

async function performScholarOneAutoLogin(page, credentials, { detectLoginPage }) {
  const usernameInput = page.locator("#USERID").first();
  const passwordInput = page.locator("#PASSWORD").first();
  const loginButton = page.locator("#logInButton").first();

  const [hasUsername, hasPassword, hasLoginButton] = await Promise.all([
    usernameInput.isVisible({ timeout: TIMEOUTS.probe }).catch(() => false),
    passwordInput.isVisible({ timeout: TIMEOUTS.probe }).catch(() => false),
    loginButton.isVisible({ timeout: TIMEOUTS.probe }).catch(() => false),
  ]);

  if (!hasUsername || !hasPassword || !hasLoginButton) {
    return { usedKnownSelectors: false };
  }

  const identity = {
    usedKnownSelectors: true,
    submittedFormDirectly: false,
    loginControlLabel: "Log In",
    usernameInputName: "USERID",
    passwordInputName: "PASSWORD",
    loginControlTag: "A",
  };

  let clickedLogin = false;
  let pressedEnterFallback = false;
  let note = null;

  try {
    await usernameInput.click({ timeout: TIMEOUTS.element });
    await usernameInput.fill(credentials.username);
    await passwordInput.click({ timeout: TIMEOUTS.element });
    await passwordInput.fill(credentials.password);

    try {
      await loginButton.click({ timeout: TIMEOUTS.element });
      clickedLogin = true;
    } catch (error) {
      note = `Kliknięcie Playwrighta nie przeszło, użyto fallbacku DOM: ${error.message}`;
      clickedLogin = await page.evaluate(() => {
        const button = document.querySelector("#logInButton");
        if (!button) return false;
        for (const type of ["mouseover", "mousedown", "mouseup"]) {
          button.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        }
        button.click();
        return true;
      });
    }

    let loggedIn = await waitForLoggedIn(page, TIMEOUTS.navigation);
    if (!loggedIn) {
      pressedEnterFallback = true;
      await passwordInput.press("Enter").catch(() => page.keyboard.press("Enter").catch(() => undefined));
      loggedIn = await waitForLoggedIn(page, TIMEOUTS.slowElement);
    }

    const stillOnLoginPage = !loggedIn && (await detectLoginPage(page));
    return {
      ...identity,
      filledUsername: true,
      filledPassword: true,
      clickedLogin,
      pressedEnterFallback,
      loginMarkersFound: loggedIn,
      stillOnLoginPage,
      loginFailureText: stillOnLoginPage ? await readLoginFailureText(page) : null,
      note,
    };
  } catch (error) {
    const stillOnLoginPage = await detectLoginPage(page);
    return {
      ...identity,
      filledUsername: false,
      filledPassword: false,
      clickedLogin,
      pressedEnterFallback,
      loginMarkersFound: false,
      stillOnLoginPage,
      loginFailureText: stillOnLoginPage ? await readLoginFailureText(page) : null,
      note: error.message,
    };
  }
}

export async function readLoginFailureText(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      ".alert, .alert-error, .error, .errors, .text-error, #error, [role='alert'], .help-inline"
    ))
      .filter(isVisible)
      .map((element) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    const failure = candidates.find((text) =>
      /invalid|incorrect|required|try\s+again|captcha|locked|expired|failed|error|not\s+recognized|nieprawid|wymagan/i.test(text)
    );
    return failure ? failure.slice(0, 300) : null;

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }).catch(() => null);
}

export async function waitForLoggedIn(page, timeout = TIMEOUTS.login) {
  const loggedIn = await page.waitForFunction((loggedInSource) => {
    const text = (document.body?.innerText || "").replace(/\s+/g, " ");
    const hasMarker = new RegExp(loggedInSource, "i").test(text);
    const hasQueueSelect = Boolean(
      document.querySelector("select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']")
    );
    const hasVisiblePassword = Array.from(document.querySelectorAll("input[type='password']")).some(isVisible);

    // Sam marker nie wystarczy: strona logowania też potrafi zawierać słowo
    // "Log In". Dopiero zniknięcie pola hasła potwierdza wejście do aplikacji.
    return (hasMarker || hasQueueSelect) && !hasVisiblePassword;

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    }
  }, LOGGED_IN_TEXT.source, { timeout }).then(() => true).catch(() => false);

  if (loggedIn) {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  }
  return loggedIn;
}
