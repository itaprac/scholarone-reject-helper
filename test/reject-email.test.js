import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  countRejectControls,
  countSaveAndSendControls,
  fillRejectEmailBody,
  pageHasEmailBody,
} from "../src/steps/reject-email.js";
import { isNoRejectControlChecklistResult } from "../src/steps/checklist.js";

// Wysłanie maila odrzucającego to jedyna nieodwracalna operacja tej ścieżki, a
// do tej pory nie miała ani jednego testu. Poniższe sprawdzają rozpoznawanie
// kontrolek i wypełnianie treści na sztucznym HTML-u o strukturze ScholarOne.

async function withPage(html, run) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await run(page);
  } finally {
    await browser.close();
  }
}

test("rozpoznaje przycisk Reject po obrazku reject.gif", async () => {
  // Obrazek musi mieć wymiary: licznik pomija elementy o zerowym prostokącie,
  // bo w przeglądarce nie dałoby się w nie kliknąć.
  const count = await withPage(
    `<a href="#" onclick="setNextPage('X')" style="display:inline-block;width:60px;height:20px">
       <img src="/images/reject.gif" alt="Reject" style="width:60px;height:20px">
     </a>`,
    countRejectControls
  );
  // Zarówno link, jak i obrazek w środku są rozpoznawane jako kontrolka.
  assert.equal(count, 2);
});

test("rozpoznaje Reject po dokładnej etykiecie i po onclick", async () => {
  const count = await withPage(
    `<button>Reject</button>
     <a href="#" onclick="immediately reject">bez etykiety</a>`,
    countRejectControls
  );
  assert.equal(count, 2);
});

test("nie myli Reject z etykietami, które tylko zawierają to słowo", async () => {
  const count = await withPage(
    `<button>Reject and Resubmit</button>
     <button>Rejected manuscripts</button>
     <a href="#">View rejection history</a>`,
    countRejectControls
  );
  assert.equal(count, 0, "tylko dokładne 'Reject' jest kontrolką odrzucenia");
});

test("nie liczy ukrytych kontrolek Reject", async () => {
  const count = await withPage(
    `<button style="display:none">Reject</button>
     <a style="visibility:hidden"><img src="reject.gif" alt="Reject"></a>`,
    countRejectControls
  );
  assert.equal(count, 0, "niewidoczna kontrolka nie jest klikalna");
});

test("brak kontrolki Reject jest rozpoznawany jako stan nieakcjonowalny", () => {
  assert.equal(
    isNoRejectControlChecklistResult({
      rejectControlsFound: 0,
      note: "Complete Checklist opened without a Reject control.",
    }),
    true
  );
  // Sama liczba zero nie wystarcza — notatka musi potwierdzać, że to ten stan,
  // a nie np. nieudane otwarcie strony.
  assert.equal(isNoRejectControlChecklistResult({ rejectControlsFound: 0, note: "timeout" }), false);
  assert.equal(
    isNoRejectControlChecklistResult({
      rejectControlsFound: 2,
      note: "Complete Checklist opened.",
    }),
    false
  );
});

test("wykrywa pole treści maila", async () => {
  const withBody = await withPage(
    `<textarea name="EMAIL_TEMPLATE_BODY">tresc</textarea>`,
    pageHasEmailBody
  );
  const withoutBody = await withPage(`<textarea name="OTHER"></textarea>`, pageHasEmailBody);

  assert.equal(withBody, true);
  assert.equal(withoutBody, false);
});

test("wypełnia treść maila i potwierdza, że zapisała się w całości", async () => {
  const message = "Dear Author(s),\n\nThank you for your submission.\n\nBest regards";
  const result = await withPage(
    `<form>
       <textarea name="EMAIL_TEMPLATE_BODY">stara tresc</textarea>
       <a id="emailPopupSaveButton" href="#">Save and Send</a>
     </form>`,
    (page) => fillRejectEmailBody(page, message)
  );

  assert.equal(result.emailBodyFilled, true);
  assert.equal(result.emailBodyLength, message.length);
  assert.equal(result.expectedEmailBodyLength, message.length);
  assert.ok(result.saveAndSendControlsFound > 0, "Save and Send musi być widoczne przed wysyłką");
});

test("zgłasza niepełne wypełnienie treści zamiast milczeć", async () => {
  const message = "Wiadomość odrzucenia";
  const result = await withPage(
    // maxlength ucina treść — dokładnie ten przypadek, w którym autor dostałby
    // obciętą wiadomość, gdyby krok nie sprawdzał wyniku
    `<textarea name="EMAIL_TEMPLATE_BODY" maxlength="5"></textarea>`,
    (page) => fillRejectEmailBody(page, message)
  );

  assert.equal(result.emailBodyFilled, false);
  assert.notEqual(result.emailBodyLength, result.expectedEmailBodyLength);
});

test("liczy kontrolki Save and Send po id, obrazku i etykiecie", async () => {
  const count = await withPage(
    `<a id="emailPopupSaveButton" href="#">zapisz</a>
     <img src="/img/save_send.gif">
     <button>Save and Send</button>`,
    countSaveAndSendControls
  );
  assert.equal(count, 3);
});

test("nie widzi Save and Send na stronie bez tej kontrolki", async () => {
  const count = await withPage(`<button>Cancel</button><a href="#">Back</a>`, countSaveAndSendControls);
  assert.equal(count, 0);
});
