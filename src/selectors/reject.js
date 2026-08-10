// Selektory ścieżki odrzucania. Trzymane osobno i zamrożone z tego samego
// powodu co REVIEWER_SELECTORS: gdy ScholarOne zmieni szablon, poprawka jest w
// jednym pliku, a testy offline od razu mówią, czy trafiła.
export const REJECT_SELECTORS = Object.freeze({
  // Kolejka Complete Checklist.
  queueAction: "select[name^='SEL_MANUSCRIPT_DETAILS_JUMP_TO_TAB_']",

  // Szybkie wyszukiwanie po ID manuskryptu w nagłówku.
  headerSearchInput: "#QUICK_SEARCH_HEADER_SEARCH_TEXT",
  headerSearchToggle: "#headerSearchbar",
  headerSearchButton: "#btn_search",

  // Popup maila odrzucającego.
  emailBody: "textarea[name='EMAIL_TEMPLATE_BODY']",
  saveAndSendButton: "#emailPopupSaveButton",
  saveAndSendImage: "img[src*='save_send.gif']",

  // Baner zgody na cookies potrafi przykryć kontrolki na całej stronie.
  cookieAccept: "button, input[type='button'], a",
});

export const REJECT_PATTERNS = Object.freeze({
  cookieAccept: /accept\s+all\s+cookies/i,
  adminCenter: /admin\s+center/i,
  completeChecklistExact: /^complete\s+checklist$/i,
  completeChecklist: /\bcomplete\s+checklist\b/i,
});
