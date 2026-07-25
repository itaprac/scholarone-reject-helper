// Dobór i dodawanie kandydatów na recenzentów, razem z popupem Create Account.
// Każde dodanie jest potwierdzane odczytem listy recenzentów — samo zamknięcie
// popupu nie jest uznawane za sukces.
import { REVIEWER_SELECTORS } from "../reviewer-selectors.js";
import { samePerson, selectUniqueCandidates } from "../reviewer-rules.js";
import { TIMEOUTS } from "../core/timeouts.js";
import { waitForNavigation } from "../core/navigation.js";
import { countReviewersTowardTarget } from "../reviewer-rules.js";
import {
  currentPaginationValue,
  readPagination,
  waitForReviewerArticle,
  navigatePagination,
  publicPerson,
  publicReviewer,
  readAllReviewerList,
  readCandidatePage,
  readReviewerPage,
  waitForReviewerListReady,
} from "./page.js";

export async function addReviewersToTarget(page, { target, initialReviewers, log, refreshCurrentReviewerTask }) {
  const added = [];
  const skipped = [];
  let reviewers = initialReviewers;
  let count = countReviewersTowardTarget(reviewers);

  while (count < target) {
    const candidate = await findNextEligibleCandidate(page, reviewers, [...added, ...skipped], log);
    if (!candidate) {
      const error = new Error(`Brak wystarczającej liczby unikalnych kandydatów. Osiągnięto ${count}/${target}.`);
      error.code = "REVIEWER_CANDIDATES_EXHAUSTED";
      error.count = count;
      error.target = target;
      error.added = added;
      error.skipped = skipped;
      throw error;
    }
    try {
      await addCandidate(page, candidate, log, refreshCurrentReviewerTask);
      reviewers = await confirmCandidateAdded(page, candidate, reviewers, log, refreshCurrentReviewerTask);
    } catch (error) {
      if (!isReviewerCandidateSkipped(error)) throw error;
      if (Array.isArray(error.reviewers)) {
        reviewers = error.reviewers;
        count = countReviewersTowardTarget(reviewers);
      }
      skipped.push(candidate);
      await log("candidate_skipped", {
        candidate: publicPerson(candidate),
        reason: error.reason,
        similarAccounts: error.similarAccounts?.map(publicPerson) || [],
        confirmation: error.confirmation || null,
        skipped: skipped.length,
      });
      continue;
    }
    added.push(candidate);
    const nextCount = countReviewersTowardTarget(reviewers);
    if (nextCount <= count) {
      throw new Error(`Dodano ${candidate.name}, ale liczba aktywnych wyborów nie wzrosła (${count} → ${nextCount}).`);
    }
    count = nextCount;
    await log("selection_progress", { count, target, added: added.length, candidate: publicPerson(candidate) });
  }
  return { added, skipped, reviewers };
}

export function isReviewerCandidateShortage(error) {
  return error?.code === "REVIEWER_CANDIDATES_EXHAUSTED";
}

export function isReviewerCandidateSkipped(error) {
  return error?.code === "REVIEWER_CANDIDATE_SKIPPED";
}

export async function requestReviewerSearchRefresh(page, log, manuscript) {
  const refresh = page.locator(REVIEWER_SELECTORS.refreshSearch);
  const count = await refresh.count();
  if (count === 0) {
    await log("reviewer_search_refresh_still_running", {
      manuscriptId: manuscript.manuscriptId,
      url: page.url(),
    });
    return { requested: false, reason: "refresh_still_running" };
  }
  if (count !== 1) {
    throw new Error(`Oczekiwano jednego widocznego Refresh Search, znaleziono ${count}.`);
  }
  if (!(await refresh.isVisible().catch(() => false))) {
    throw new Error(`Znaleziono Refresh Search dla ${manuscript.manuscriptId}, ale przycisk nie jest widoczny.`);
  }

  const href = await refresh.getAttribute("href");
  await log("reviewer_search_refresh_ready", {
    manuscriptId: manuscript.manuscriptId,
    hasTaskId: /XIK_CURRENT_DOCUMENT_TASK_ID/i.test(href || ""),
    url: page.url(),
  });
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  }).then(() => true).catch(() => false);
  await refresh.click();
  const navigated = await navigation;
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await log("reviewer_search_refresh_clicked", {
    manuscriptId: manuscript.manuscriptId,
    navigated,
    url: page.url(),
  });
  return { requested: true, reason: "candidate_pool_exhausted" };
}

export async function findNextEligibleCandidate(page, reviewers, added, log) {
  const pagination = await readPagination(page, REVIEWER_SELECTORS.candidatePagination);
  const values = pagination?.options.map(({ value }) => value) || [null];

  for (const value of values.slice(0, 50)) {
    if (value !== null && value !== (await currentPaginationValue(page, REVIEWER_SELECTORS.candidatePagination))) {
      await navigatePagination(page, REVIEWER_SELECTORS.candidatePagination, value);
    }
    const candidates = await readCandidatePage(page);
    const selected = selectUniqueCandidates(candidates, [...reviewers, ...added], 1)[0] || null;
    await log("candidate_page_scanned", {
      pageValue: value,
      candidates: candidates.length,
      eligible: selected ? publicPerson(selected) : null,
    });
    if (selected) return selected;
  }
  return null;
}

export async function addCandidate(page, candidate, log, refreshCurrentReviewerTask = async () => false) {
  const locator = page.locator(`a[href*='${candidate.id}']`).filter({
    has: page.locator("img[src$='/add.gif']"),
  }).first();
  if (!(await locator.count())) throw new Error(`Przycisk Add zniknął dla ${candidate.name}.`);

  await log("candidate_add_started", { candidate: publicPerson(candidate), popupExpected: candidate.popupExpected });
  if (candidate.popupExpected) {
    const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
    await locator.click();
    const popup = await popupPromise;
    let popupError;
    try {
      await handleCreateAccountPopup(popup, candidate, log);
    } catch (error) {
      popupError = error;
    }
    await page.bringToFront().catch(() => undefined);
    try {
      await waitForReviewerArticle(page, 15_000);
    } catch (error) {
      await log("reviewer_article_refresh_after_create_account", {
        candidate: publicPerson(candidate),
        reason: error.message,
        url: page.url(),
      });
      if (!(await refreshCurrentReviewerTask(page, log, "create_account_parent_not_ready"))) {
        throw error;
      }
    }
    if (popupError) throw popupError;
  } else {
    const navigation = page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    }).then(() => true).catch(() => false);
    await locator.click();
    const navigated = await navigation;
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    await log("candidate_add_navigation_finished", {
      candidate: publicPerson(candidate),
      navigated,
      url: page.url(),
    });
  }
  await log("candidate_add_action_finished", { candidate: publicPerson(candidate), url: page.url() });
}

export async function handleCreateAccountPopup(popup, candidate, log) {
  await popup.waitForLoadState("domcontentloaded");
  const createAndAdd = popup.locator(REVIEWER_SELECTORS.createAndAdd);
  await createAndAdd.waitFor({ state: "visible", timeout: 15_000 });
  const createAndAddCount = await createAndAdd.count();
  if (createAndAddCount !== 1) {
    throw new Error(
      `Oczekiwano jednego widocznego Create and Add dla ${candidate.name}, znaleziono ${createAndAddCount}.`
    );
  }
  const popupPerson = {
    name: [
      await popup.locator("input[name='PERSON_FIRSTNAME']").inputValue().catch(() => ""),
      await popup.locator("input[name='PERSON_LASTNAME']").inputValue().catch(() => ""),
    ].filter(Boolean).join(" "),
    email: await popup.locator("input[name='EMAIL_ADDRESS']").inputValue().catch(() => ""),
  };
  if (!samePerson(candidate, popupPerson)) {
    throw new Error(`Popup Create Account nie odpowiada kandydatowi ${candidate.name}.`);
  }
  await log("create_account_popup_opened", { candidate: publicPerson(candidate), popupPerson });

  const navigation = waitForNavigation(popup, 12_000);
  await createAndAdd.click();
  await navigation;
  await log("create_and_add_clicked", { candidate: publicPerson(candidate), popupClosed: popup.isClosed() });

  const deadline = Date.now() + 30_000;
  let existingEmailConfirmationAttempted = false;
  while (!popup.isClosed() && Date.now() < deadline) {
    const popupBodyText = await popup.locator("body").innerText().catch(() => "");
    const blockingReason = createAccountBlockingReason(popupBodyText);
    if (blockingReason) {
      await log("create_account_blocked", {
        candidate: publicPerson(candidate),
        reason: blockingReason,
        message: popupBodyText.replace(/\s+/g, " ").trim().slice(0, 500),
      });
      const closed = await popup.close().then(() => true).catch(() => popup.isClosed());
      if (!closed && !popup.isClosed()) {
        throw new Error(`Nie udało się zamknąć zablokowanego popupu dla ${candidate.name}.`);
      }
      const error = new Error(
        `Pomijam ${candidate.name}/${candidate.email}: ScholarOne wymaga administracyjnego scalenia zduplikowanych kont.`
      );
      error.code = "REVIEWER_CANDIDATE_SKIPPED";
      error.reason = blockingReason;
      throw error;
    }

    const existingEmailConflict = await readExistingEmailConflict(popup, candidate, {
      controlVisibilityTimeout: 5_000,
    });
    if (existingEmailConflict) {
      await log("existing_email_conflict_detected", {
        candidate: publicPerson(candidate),
        email: existingEmailConflict.email,
        emailMatches: existingEmailConflict.emailMatches,
        controlCount: existingEmailConflict.controlCount,
        controlVisible: existingEmailConflict.controlVisible,
      });
      if (!existingEmailConflict.emailMatches) {
        throw new Error(
          `ScholarOne zgłasza istniejący e-mail ${existingEmailConflict.email}, który nie odpowiada ${candidate.email}.`
        );
      }
      if (existingEmailConfirmationAttempted) {
        throw new Error(`Save and Add nie zamknął popupu istniejącego konta dla ${candidate.name}.`);
      }
      if (existingEmailConflict.controlCount !== 1 || !existingEmailConflict.controlVisible) {
        throw new Error(
          `Oczekiwano jednego widocznego Save and Add dla istniejącego konta ${candidate.name}; ` +
          `znaleziono ${existingEmailConflict.controlCount}, widocznych ${existingEmailConflict.controlVisible ? 1 : 0}.`
        );
      }

      existingEmailConfirmationAttempted = true;
      await log("existing_email_save_and_add_started", {
        candidate: publicPerson(candidate),
        email: existingEmailConflict.email,
      });
      const saveAndAdd = popup.locator(REVIEWER_SELECTORS.existingEmailSaveAndAdd);
      const completion = Promise.race([
        popup.waitForEvent("close", { timeout: 20_000 }).then(() => "closed").catch(() => null),
        popup.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 20_000,
        }).then(() => "navigated").catch(() => null),
      ]);
      await saveAndAdd.click();
      const completionType = await completion;
      await popup.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
      await log("existing_email_save_and_add_finished", {
        candidate: publicPerson(candidate),
        completionType,
        popupClosed: popup.isClosed(),
      });
      continue;
    }

    const similarAccounts = await readPopupAddOptions(popup);
    const match = findMatchingSimilarAccount(candidate, similarAccounts);
    if (match) {
      await log("similar_account_found", { candidate: publicPerson(candidate), account: publicPerson(match) });
      const add = popup.locator(`a[href*='${match.id}']`).filter({
        has: popup.locator("img[src$='/add.gif']"),
      }).first();
      const addNavigation = waitForNavigation(popup, 12_000);
      await add.click();
      await addNavigation;
      await log("similar_account_add_clicked", { account: publicPerson(match) });
      continue;
    }
    if (similarAccounts.length > 0) {
      await log("similar_accounts_no_match", {
        candidate: publicPerson(candidate),
        accounts: similarAccounts.map(publicPerson),
      });
      const closed = await popup.close().then(() => true).catch(() => popup.isClosed());
      if (!closed && !popup.isClosed()) {
        throw new Error(`Nie udało się zamknąć popupu z niedopasowanymi kontami dla ${candidate.name}.`);
      }
      const error = new Error(
        `Pomijam ${candidate.name}/${candidate.email}: ScholarOne pokazał podobne konta, ale żadne nie pasuje.`
      );
      error.code = "REVIEWER_CANDIDATE_SKIPPED";
      error.reason = "similar_accounts_no_match";
      error.similarAccounts = similarAccounts;
      throw error;
    }
    await popup.waitForTimeout(500).catch(() => undefined);
  }
  if (!popup.isClosed()) {
    throw new Error(`Popup Create Account nie zamknął się po dodaniu ${candidate.name}.`);
  }
  await log("create_account_popup_closed", { candidate: publicPerson(candidate) });
}

export function createAccountBlockingReason(bodyText) {
  const text = String(bodyText || "").replace(/\s+/g, " ").trim();
  const duplicatePeople = /duplicate\s+people\s+in\s+the\s+system\s+exist\s+with\s+this\s+e-?mail\s+address/i.test(text);
  const mergeRequired = /(?:user\s+)?administration\s*\/\s*merge\s+tools/i.test(text);
  return duplicatePeople && mergeRequired ? "duplicate_people_merge_required" : null;
}

export function findMatchingSimilarAccount(candidate, similarAccounts) {
  const candidateEmail = String(candidate?.email || "").trim().toLowerCase();
  if (candidateEmail) {
    return similarAccounts.find((account) =>
      String(account?.email || "").trim().toLowerCase() === candidateEmail
    ) || null;
  }
  return similarAccounts.find((account) => samePerson(candidate, account)) || null;
}

export async function readExistingEmailConflict(popup, candidate, {
  controlVisibilityTimeout = 0,
} = {}) {
  if (popup.isClosed()) return null;
  const warningVisible = await popup.locator("body").innerText()
    .then((text) => /person with this e-?mail address already exists in the system/i.test(text))
    .catch(() => false);
  if (!warningVisible) return null;

  const email = await popup.locator("input[name='EMAIL_ADDRESS']").inputValue().catch(() => "");
  const candidateEmail = String(candidate?.email || "").trim().toLowerCase();
  const control = popup.locator(REVIEWER_SELECTORS.existingEmailSaveAndAdd);
  if (controlVisibilityTimeout > 0) {
    await control.waitFor({
      state: "visible",
      timeout: controlVisibilityTimeout,
    }).catch(() => undefined);
  }
  if (popup.isClosed()) return null;
  const controlCount = await control.count().catch(() => 0);
  const controlVisible = controlCount === 1 && await control.isVisible().catch(() => false);
  return {
    email,
    emailMatches: Boolean(candidateEmail) && email.trim().toLowerCase() === candidateEmail,
    controlCount,
    controlVisible,
  };
}

export async function readPopupAddOptions(popup) {
  return popup.evaluate((selector) => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    return Array.from(document.querySelectorAll(selector)).map((link, index) => {
      const row = link.closest("tr");
      const text = clean(row?.innerText || row?.textContent);
      return {
        id: (link.getAttribute("href") || "").match(/xik_[A-Za-z0-9]+/)?.[0] || String(index),
        name: clean(row?.querySelector("b")?.textContent) || null,
        email: text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null,
      };
    }).filter(({ name, email }) => name || email);
  }, REVIEWER_SELECTORS.candidateAdd).catch(() => []);
}

export async function confirmCandidateAdded(page, candidate, beforeReviewers, log, refreshCurrentReviewerTask = async () => false) {
  let reviewers = beforeReviewers;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    reviewers = await readAllReviewerList(page, log);
    const match = reviewers.find((reviewer) => samePerson(candidate, reviewer));
    if (match) {
      await log("candidate_confirmed_in_reviewer_list", {
        attempt,
        candidate: publicPerson(candidate),
        reviewer: publicReviewer(match),
      });
      return reviewers;
    }
    if (attempt === 3 || attempt === 6) {
      await log("candidate_confirmation_refresh_started", {
        attempt,
        candidate: publicPerson(candidate),
        url: page.url(),
      });
      await refreshCurrentReviewerTask(page, log, "candidate_confirmation");
    } else {
      await page.waitForTimeout(1500);
    }
  }

  const confirmation = candidateAddConfirmationState(beforeReviewers, reviewers);
  await log("candidate_add_not_confirmed", {
    candidate: publicPerson(candidate),
    ...confirmation,
  });
  if (confirmation.rosterUnchanged) {
    const error = new Error(
      `Pomijam ${candidate.name}: ScholarOne zamknął Add, ale Reviewer List pozostała bez zmian.`
    );
    error.code = "REVIEWER_CANDIDATE_SKIPPED";
    error.reason = "candidate_not_added";
    error.reviewers = reviewers;
    error.confirmation = confirmation;
    throw error;
  }

  throw new Error(
    `${candidate.name} nie został jednoznacznie rozpoznany po Add, a skład Reviewer List zmienił się ` +
    `(${confirmation.beforeTotal} → ${confirmation.afterTotal}). Zatrzymuję skrypt, aby nie dodać nadmiarowego recenzenta.`
  );
}

export function candidateAddConfirmationState(beforeReviewers, afterReviewers) {
  const before = Array.isArray(beforeReviewers) ? beforeReviewers : [];
  const after = Array.isArray(afterReviewers) ? afterReviewers : [];
  const sameRoster = before.length === after.length && before.every((previous) =>
    after.some((current) =>
      Boolean(previous?.id && current?.id && previous.id === current.id) || samePerson(previous, current)
    )
  );
  return {
    rosterUnchanged: sameRoster,
    beforeTotal: before.length,
    afterTotal: after.length,
    beforeCountTowardTarget: countReviewersTowardTarget(before),
    afterCountTowardTarget: countReviewersTowardTarget(after),
  };
}
