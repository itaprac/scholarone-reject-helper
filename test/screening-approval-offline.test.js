import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  approveAndAssignEditors,
  assignEditor,
  checkApprovalChecklist,
  inspectApprovalChecklist,
  inspectEditorAssignment,
  verifyFinalAssignments,
} from "../src/screening-approval.js";

// Te snapshoty nie zachowały się do przeniesienia do repo. Wskaż katalog przez
// SCHOLARONE_HTML_DIR, żeby uruchomić testy na własnych zrzutach ScholarOne.
const htmlDir = process.env.SCHOLARONE_HTML_DIR || "";
const FIXTURES = {
  checklist: path.join(htmlDir, "approve_page.html"),
  editorInChief: path.join(htmlDir, "after_aprove.html"),
  associateEditor: path.join(htmlDir, "AE_select.html"),
};
const missingFixtures = Object.values(FIXTURES).filter((file) => !fs.existsSync(file));

test("offline ScholarOne approval snapshots expose exact checklist and editor controls", {
  skip: missingFixtures.length ? `Brak snapshotów: ${missingFixtures.join(", ")}` : false,
}, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`file://${FIXTURES.checklist}`, { waitUntil: "domcontentloaded" });
    const checklistBefore = await inspectApprovalChecklist(page);
    assert.equal(checklistBefore.adminChecklistFound, true);
    assert.equal(checklistBefore.approveLinkCount, 1);
    assert.equal(checklistBefore.items.length, 2);
    assert.ok(checklistBefore.items.every((item) => item.found));
    assert.equal(new Set(checklistBefore.items.map((item) => item.name)).size, 2);
    const checklistAfter = await checkApprovalChecklist(page);
    assert.ok(checklistAfter.items.every((item) => item.checked));

    await page.goto(`file://${FIXTURES.editorInChief}`, { waitUntil: "domcontentloaded" });
    const editorInChief = await inspectEditorAssignment(page, {
      roleHeading: "Editor-in-Chief List",
    });
    assert.equal(editorInChief.headingCount, 1);
    assert.equal(editorInChief.matches.length, 1);
    assert.match(editorInChief.matches[0].optionLabel, /Sałabun, Wojciech/);
    assert.equal(editorInChief.matches[0].assignLinkCount, 1);

    await page.goto(`file://${FIXTURES.associateEditor}`, { waitUntil: "domcontentloaded" });
    const associateEditor = await inspectEditorAssignment(page, {
      roleHeading: "Associate Editor List",
    });
    assert.equal(associateEditor.headingCount, 1);
    assert.equal(associateEditor.matches.length, 1);
    assert.match(associateEditor.matches[0].optionLabel, /Sałabun, Wojciech/);
    assert.equal(associateEditor.matches[0].assignLinkCount, 1);
  } finally {
    await browser.close();
  }
});

test("editor assignment selects Wojciech Sałabun and advances through EIC and AE", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.setContent(assignmentPage("Editor-in-Chief List", "EIC", assignmentPage(
      "Associate Editor List",
      "AE",
      "<p>EIC: Sa&#322;abun, Wojciech</p><p>AE: Sa&#322;abun, Wojciech</p>"
    )));

    const eic = await assignEditor(page, {
      roleHeading: "Editor-in-Chief List",
      nextRoleHeading: "Associate Editor List",
      timeout: 250,
    });
    assert.equal(eic.assigned, true);

    const ae = await assignEditor(page, {
      roleHeading: "Associate Editor List",
      timeout: 250,
    });
    assert.equal(ae.assigned, true);

    const verification = await verifyFinalAssignments(page);
    assert.equal(verification.editorInChiefAssigned, true);
    assert.equal(verification.associateEditorAssigned, true);
  } finally {
    await browser.close();
  }
});

test("an approved revision continues when ScholarOne keeps its existing EIC and AE", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const completedPage = `
      <h1>Manuscript Details</h1>
      <p>KES-25-0435.R1</p>
      <p>EIC: Sa&#322;abun, Wojciech (proxy)</p>
      <p>AE: Sa&#322;abun, Wojciech (proxy)</p>
      <p>Invite Reviewers</p>`;
    await page.setContent(checklistPage(completedPage));

    const result = await approveAndAssignEditors(page, {
      allowExistingAssignments: true,
      timeout: 250,
    });

    assert.equal(result.completed, true);
    assert.equal(result.approval.existingAssignments, true);
    assert.equal(result.approval.nextStep, "Existing editor assignments");
    assert.equal(result.editorInChief.source, "existing-assignment");
    assert.equal(result.associateEditor.source, "existing-assignment");
    assert.equal(result.assignmentVerification.editorInChiefAssigned, true);
    assert.equal(result.assignmentVerification.associateEditorAssigned, true);
  } finally {
    await browser.close();
  }
});

function assignmentPage(heading, roleToken, nextBody) {
  return `<!doctype html><html><body>
    <b>${heading}</b>
    <table><tr><td>
      <select name="XIK_WORKFLOW_ASSIGN_TO_123">
        <option value="placeholder">Select an ${roleToken}</option>
        <option value="wojciech">Sa&#322;abun, Wojciech (kes Office) (0)</option>
      </select>
    </td><td>
      <a href="javascript:void(0)" onclick="document.body.innerHTML=atob('${Buffer.from(nextBody).toString("base64")}')">
        <img src="/assign.gif" alt="Assign" width="20" height="10">
      </a>
    </td></tr></table>
  </body></html>`;
}

function checklistPage(nextBody) {
  const labels = [
    "Manuscript and images checked for acceptability",
    "Manuscript complies with submission guidelines and requirements",
  ];
  return `<!doctype html><html><body>
    <b>Admin Checklist</b>
    <table>
      ${labels.map((label, index) => `<tr>
        <td><span class="pagecontents">${label}</span></td>
        <td><input type="checkbox" name="CUSTOM_${index}"></td>
      </tr>`).join("")}
    </table>
    <a href="javascript:void(0)" onclick="document.body.innerHTML=atob('${Buffer.from(nextBody).toString("base64")}')">
      <img src="/approve.gif" alt="Approve">
    </a>
  </body></html>`;
}
