import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { navigatePagination, readAllReviewerList, readReviewerPage } from "../src/reviewers/page.js";

function row(id, name) {
  return `<tr><td><input name="XIK_RP_ID_${id}" value="${id}"></td>
    <td>${name}</td><td>Declined</td><td></td></tr>`;
}

test("counts distinct roster records before matching people", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<table><tr><td><b>Reviewer List</b> 1-2 of 2</td></tr></table>
      <table>${row("record-1", "Sample, Reviewer")}${row("record-2", "Sample, Reviewer")}</table>`);
    const reviewers = await readAllReviewerList(page);
    assert.deepEqual(reviewers.map(({ id }) => id), ["record-1", "record-2"]);
  } finally {
    await browser.close();
  }
});

test("retries a read-only page change when the server returns the previous page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let posts = 0;
    await page.route("https://scholarone.test/**", async (route) => {
      if (route.request().method() === "POST") posts += 1;
      const selected = posts < 2 ? "1" : "2";
      await route.fulfill({ contentType: "text/html", body: `
        <form method="post"><select name="page_select" onchange="this.form.submit()">
          <option value="1" ${selected === "1" ? "selected" : ""}>1-50 of 51</option>
          <option value="2" ${selected === "2" ? "selected" : ""}>51-51 of 51</option>
        </select><p id="loaded">${selected}</p></form>
      ` });
    });
    await page.goto("https://scholarone.test/");
    await navigatePagination(page, "select", "2", { stateTimeout: 50 });
    assert.equal(await page.locator("#loaded").innerText(), "2");
    assert.equal(posts, 2);
  } finally {
    await browser.close();
  }
});

test("reads the selected range instead of text from another pagination option", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<table><tr><td><b>Reviewer List</b>
      <select onchange="void('REV_CURRENT_PAGE_NO')">
        <option value="2">51-51 of 51</option><option value="1" selected>1-50 of 51</option>
      </select></td></tr></table>
      <table>${Array.from({ length: 50 }, (_, i) => row(String(i), `Reviewer ${i}`)).join("")}</table>`);
    const result = await readReviewerPage(page);
    assert.equal(result.range.start, 1);
    assert.equal(result.range.end, result.reviewers.length);
  } finally {
    await browser.close();
  }
});

test("still rejects an incomplete roster", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<table><tr><td><b>Reviewer List</b> 1-2 of 2</td></tr></table>
      <table>${row("record-1", "Sample, Reviewer")}</table>`);
    await assert.rejects(readAllReviewerList(page), /zgłasza 2 osób, ale odczytano tylko 1/);
  } finally {
    await browser.close();
  }
});

test("stops after two page requests when the server keeps returning the wrong page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let posts = 0;
    await page.route("https://scholarone.test/**", async (route) => {
      if (route.request().method() === "POST") posts += 1;
      await route.fulfill({ contentType: "text/html", body: `
        <form method="post"><select onchange="this.form.submit()">
          <option value="1">1</option><option value="2">2</option>
        </select></form>` });
    });
    await page.goto("https://scholarone.test/");
    await assert.rejects(navigatePagination(page, "select", "2", { stateTimeout: 50 }), /po 2 próbach/);
    assert.equal(posts, 2);
  } finally {
    await browser.close();
  }
});

test("collects every roster page and restores the initial page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const readPages = [];
    await page.route("https://scholarone.test/**", async (route) => {
      const current = new URLSearchParams(route.request().postData() || "").get("page_select") || "1";
      const ids = current === "1" ? ["1", "2"] : ["3"];
      await route.fulfill({ contentType: "text/html", body: `<form method="post">
        <table><tr><td><b>Reviewer List</b>
          <select name="page_select" onchange="void('REV_CURRENT_PAGE_NO'); this.form.submit()">
            <option value="1">1-2 of 3</option><option value="2" ${current === "2" ? "selected" : ""}>3-3 of 3</option>
          </select></td></tr></table>
        <table>${ids.map((id) => row(id, `Sample Reviewer ${id}`)).join("")}</table></form>` });
    });
    await page.goto("https://scholarone.test/");
    const reviewers = await readAllReviewerList(page, async (type, entry) => {
      if (type === "reviewer_list_page_read") readPages.push(entry.range.start);
    });
    assert.deepEqual(reviewers.map(({ id }) => id), ["1", "2", "3"]);
    assert.deepEqual(readPages, [1, 3]);
    assert.equal(await page.locator("select").inputValue(), "1");
  } finally {
    await browser.close();
  }
});

test("repeated complete reads avoid return trips while verifying every record", async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let requests = 0;
    await page.route("https://scholarone.test/**", async (route) => {
      if (route.request().method() === "POST") {
        requests += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const current = new URLSearchParams(route.request().postData() || "").get("page_select") || "1";
      await route.fulfill({ contentType: "text/html", body: `<form method="post">
        <table><tr><td><b>Reviewer List</b><select name="page_select"
          onchange="void('REV_CURRENT_PAGE_NO');this.form.submit()">
          <option value="1">1-1 of 2</option><option value="2" ${current === "2" ? "selected" : ""}>2-2 of 2</option>
        </select></td></tr></table><table>${row(current, `Reviewer ${current}`)}</table></form>` });
    });
    await page.goto("https://scholarone.test/");
    const started = performance.now();
    for (let i = 0; i < 6; i += 1) {
      const reviewers = await readAllReviewerList(page, async () => {}, { restorePage: false });
      assert.deepEqual(reviewers.map(({ id }) => id).sort(), ["1", "2"]);
    }
    t.diagnostic(`Six complete reads: ${requests} requests, ${Math.round(performance.now() - started)} ms`);
    assert.equal(requests, 6);
  } finally {
    await browser.close();
  }
});
