import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  hasUnusualActivityAlert,
  readAbstractFromPopup,
  readManuscriptSummary,
  SCREENING_SELECTORS,
  waitForManuscriptMetadataReady,
} from "../src/screening-metadata.js";

const htmlDir = process.env.SCHOLARONE_HTML_DIR || "/Users/itaprac/Downloads";
const files = {
  details: path.join(htmlDir, "Article_details.html"),
  abstract: path.join(htmlDir, "Abstract_popup.html"),
};
const missing = Object.values(files).filter((file) => !fs.existsSync(file));

test("reads title and abstract from the supplied ScholarOne snapshots", {
  skip: missing.length ? `Brak snapshotów: ${missing.join(", ")}` : false,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ javaScriptEnabled: false });

  try {
    const details = await loadPage(context, files.details);
    await waitForManuscriptMetadataReady(details, 2_000);
    assert.deepEqual(await readManuscriptSummary(details), {
      manuscriptId: "KES-26-0872",
      title: "An AI-Enabled Framework for Rhizome Rot Detection in Turmeric Using Laplace Pyramid and Attention-Driven Pyramid Vision Transformer for Classification",
      reason: null,
    });

    const abstractLink = details.locator(SCREENING_SELECTORS.abstractLink)
      .filter({ hasText: /^\s*Abstract\s*$/i });
    assert.equal(await abstractLink.count(), 1);
    assert.match(await abstractLink.getAttribute("href"), /popWindow\(.+ms_preview/is);
    assert.equal(hasUnusualActivityAlert(await details.locator("body").innerText()), false);

    const popup = await loadPage(context, files.abstract);
    const abstract = await readAbstractFromPopup(popup);
    assert.match(abstract, /^One of the precious crops is turmeric/);
    assert.match(abstract, /Experimental results are conducted/);
    assert.ok(abstract.length > 1_500);
  } finally {
    await browser.close();
  }
});

test("recognizes the red unusual-activity message used by auto-reject", () => {
  assert.equal(hasUnusualActivityAlert("High rate of unusual activity"), true);
  assert.equal(hasUnusualActivityAlert("HIGH   RATE OF UNUSUAL\nACTIVITY"), true);
  assert.equal(hasUnusualActivityAlert("Complete Checklist"), false);
});

async function loadPage(context, file) {
  const page = await context.newPage();
  await page.setContent(await fsp.readFile(file, "utf8"), { waitUntil: "domcontentloaded" });
  return page;
}
