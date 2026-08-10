export const APPROVAL_CHECKLIST_LABELS = Object.freeze([
  "Manuscript and images checked for acceptability",
  "Manuscript complies with submission guidelines and requirements",
]);

export const DEFAULT_EDITOR_NAME = "Sałabun, Wojciech";

export async function inspectApprovalChecklist(page) {
  return page.evaluate((labels) => {
    const normalizedLabels = labels.map(clean);
    const labelElements = Array.from(document.querySelectorAll("span.pagecontents, td.dataentry"));
    const items = normalizedLabels.map((label) => {
      const labelElement = labelElements.find((candidate) => clean(candidate.textContent) === label);
      const row = labelElement?.closest("tr") || null;
      const checkbox = row?.querySelector("input[type='checkbox']") || null;
      return {
        label,
        found: Boolean(checkbox),
        name: checkbox?.getAttribute("name") || null,
        checked: Boolean(checkbox?.checked),
      };
    });
    const approveLinks = Array.from(document.querySelectorAll("a[href]"))
      .filter((link) => link.querySelector(":scope > img[src$='/approve.gif'], :scope > img[src$='approve.gif']"));
    return {
      adminChecklistFound: Array.from(document.querySelectorAll("b"))
        .some((element) => /^Admin Checklist$/i.test(clean(element.textContent))),
      items,
      approveLinkCount: approveLinks.length,
    };

    function clean(value) {
      return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
  }, APPROVAL_CHECKLIST_LABELS);
}

export async function checkApprovalChecklist(page) {
  const before = await inspectApprovalChecklist(page);
  if (!before.adminChecklistFound) {
    throw new Error("Nie znaleziono sekcji Admin Checklist.");
  }
  if (before.items.some((item) => !item.found || !item.name)) {
    const missing = before.items.filter((item) => !item.found).map((item) => item.label);
    throw new Error(`Nie znaleziono wymaganych checkboxów checklisty: ${missing.join("; ")}`);
  }
  if (new Set(before.items.map((item) => item.name)).size !== APPROVAL_CHECKLIST_LABELS.length) {
    throw new Error("Wymagane pozycje checklisty nie wskazują dwóch różnych checkboxów.");
  }
  if (before.approveLinkCount !== 1) {
    throw new Error(`Oczekiwano jednego przycisku Approve, znaleziono ${before.approveLinkCount}.`);
  }

  for (const item of before.items) {
    const checkbox = page.locator(`input[type='checkbox'][name=${JSON.stringify(item.name)}]`);
    if (await checkbox.count() !== 1) {
      throw new Error(`Checkbox ${item.name} nie jest unikalny.`);
    }
    if (!await checkbox.isChecked()) {
      await checkbox.check();
    }
  }

  const after = await inspectApprovalChecklist(page);
  if (after.items.some((item) => !item.checked)) {
    throw new Error("Nie udało się zaznaczyć obu wymaganych checkboxów checklisty.");
  }
  return after;
}

export async function submitChecklistApproval(page, {
  timeout = 20_000,
  allowExistingAssignments = false,
  editorName = DEFAULT_EDITOR_NAME,
} = {}) {
  const approveLink = page.locator("a[href]").filter({
    has: page.locator(":scope > img[src$='/approve.gif'], :scope > img[src$='approve.gif']"),
  });
  const count = await approveLink.count();
  if (count !== 1) {
    throw new Error(`Oczekiwano jednego przycisku Approve, znaleziono ${count}.`);
  }

  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout })
    .catch(() => null);
  await approveLink.click({ timeout: 10_000 });
  await navigation;

  if (allowExistingAssignments) {
    const destination = await waitForAssignmentOrExistingEditors(page, {
      editorName,
      timeout,
    });
    return {
      clicked: true,
      nextStep: destination === "existing-assignments"
        ? "Existing editor assignments"
        : "Editor-in-Chief List",
      existingAssignments: destination === "existing-assignments",
    };
  }

  await waitForAssignmentPage(page, "Editor-in-Chief List", { timeout });
  return {
    clicked: true,
    nextStep: "Editor-in-Chief List",
    existingAssignments: false,
  };
}

export async function inspectEditorAssignment(page, {
  roleHeading,
  editorName = DEFAULT_EDITOR_NAME,
} = {}) {
  return page.evaluate(({ expectedHeading, expectedEditor }) => {
    const headingCount = Array.from(document.querySelectorAll("b"))
      .filter((element) => clean(element.textContent) === expectedHeading).length;
    const roleToken = /editor-in-chief/i.test(expectedHeading) ? "EIC" : "AE";
    const expectedName = normalize(expectedEditor);
    const matches = Array.from(document.querySelectorAll("select[name^='XIK_WORKFLOW_ASSIGN_TO_']"))
      .map((select) => {
        const options = Array.from(select.options);
        const placeholder = normalize(options[0]?.textContent);
        const option = options.find((candidate) => normalize(candidate.textContent).includes(expectedName));
        const container = select.closest("table");
        const assignLinks = Array.from(container?.querySelectorAll("a") || [])
          .filter((link) => link.querySelector("img[src*='assign.gif']"));
        return {
          selectName: select.getAttribute("name"),
          placeholder,
          optionValue: option?.value || null,
          optionLabel: clean(option?.textContent),
          assignLinkCount: assignLinks.length,
        };
      })
      .filter((entry) => entry.placeholder.includes(normalize(roleToken)) && entry.optionValue);

    return { roleHeading: expectedHeading, headingCount, matches };

    function clean(value) {
      return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }

    function normalize(value) {
      return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    }
  }, { expectedHeading: roleHeading, expectedEditor: editorName });
}

export async function assignEditor(page, {
  roleHeading,
  editorName = DEFAULT_EDITOR_NAME,
  nextRoleHeading = null,
  timeout = 20_000,
} = {}) {
  const inspection = await inspectEditorAssignment(page, { roleHeading, editorName });
  if (inspection.headingCount !== 1) {
    throw new Error(`Oczekiwano nagłówka „${roleHeading}” dokładnie raz, znaleziono ${inspection.headingCount}.`);
  }
  if (inspection.matches.length !== 1) {
    throw new Error(`Nie znaleziono jednoznacznego wyboru ${editorName} dla roli ${roleHeading}.`);
  }
  const match = inspection.matches[0];
  if (match.assignLinkCount !== 1) {
    throw new Error(`Oczekiwano jednego przycisku Assign dla ${roleHeading}, znaleziono ${match.assignLinkCount}.`);
  }

  const select = page.locator(`select[name=${JSON.stringify(match.selectName)}]`);
  await select.selectOption(match.optionValue);
  const selectedValue = await select.inputValue();
  if (selectedValue !== match.optionValue) {
    throw new Error(`Nie udało się wybrać ${editorName} dla roli ${roleHeading}.`);
  }

  const assignLink = select.locator("xpath=ancestor::table[1]").locator("a").filter({
    has: page.locator("img[src*='assign.gif']"),
  });
  if (await assignLink.count() !== 1) {
    throw new Error(`Przycisk Assign dla ${roleHeading} przestał być jednoznaczny.`);
  }

  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout })
    .catch(() => null);
  await assignLink.click({ timeout: 10_000 });
  await navigation;
  if (nextRoleHeading) {
    await waitForAssignmentPage(page, nextRoleHeading, { timeout });
  }

  return {
    assigned: true,
    roleHeading,
    editorName,
    optionLabel: match.optionLabel,
    nextRoleHeading,
  };
}

export async function approveAndAssignEditors(page, {
  editorName = DEFAULT_EDITOR_NAME,
  timeout = 20_000,
  allowExistingAssignments = false,
  skipEditorAssignment = false,
} = {}) {
  const checklist = await checkApprovalChecklist(page);
  const approval = await submitChecklistApproval(page, {
    timeout,
    allowExistingAssignments,
    editorName,
  });

  // Strona „Editor-in-Chief List" potwierdza, że Approve przeszedł — manuskrypt
  // jest już w Awaiting EIC Assignment. Dobieranie zostaje dla człowieka, który
  // najpierw przejrzy PDF.
  if (skipEditorAssignment && !approval.existingAssignments) {
    return {
      completed: true,
      awaitingEditorAssignment: true,
      checklist,
      approval,
      editorInChief: {
        assigned: false,
        source: "left-for-manual-assignment",
      },
      associateEditor: {
        assigned: false,
        source: "left-for-manual-assignment",
      },
    };
  }

  if (approval.existingAssignments) {
    const assignmentVerification = await verifyFinalAssignments(page, editorName);
    if (!assignmentVerification.editorInChiefAssigned || !assignmentVerification.associateEditorAssigned) {
      throw new Error(`ScholarOne pominął wybór edytorów, ale nie potwierdzono obu ról dla ${editorName}.`);
    }
    return {
      completed: true,
      checklist,
      approval,
      editorInChief: {
        assigned: true,
        editorName,
        source: "existing-assignment",
      },
      associateEditor: {
        assigned: true,
        editorName,
        source: "existing-assignment",
      },
      assignmentVerification,
    };
  }

  const editorInChief = await assignEditor(page, {
    roleHeading: "Editor-in-Chief List",
    editorName,
    nextRoleHeading: "Associate Editor List",
    timeout,
  });
  const associateEditor = await assignEditor(page, {
    roleHeading: "Associate Editor List",
    editorName,
    timeout,
  });

  const assignmentVerification = await verifyFinalAssignments(page, editorName);
  if (!assignmentVerification.editorInChiefAssigned || !assignmentVerification.associateEditorAssigned) {
    throw new Error(`Assign zakończył nawigację, ale nie potwierdzono obu ról dla ${editorName}.`);
  }

  return {
    completed: true,
    checklist,
    approval,
    editorInChief,
    associateEditor,
    assignmentVerification,
  };
}

export async function waitForAssignmentPage(page, roleHeading, { timeout = 20_000 } = {}) {
  await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
  await page.waitForFunction((expectedHeading) => Array.from(document.querySelectorAll("b"))
    .some((element) => (element.textContent || "").replace(/\s+/g, " ").trim() === expectedHeading),
  roleHeading, { timeout });
}

export async function waitForAssignmentOrExistingEditors(page, {
  editorName = DEFAULT_EDITOR_NAME,
  timeout = 20_000,
} = {}) {
  await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
  const destination = await page.waitForFunction(({ expectedEditor }) => {
    const hasEditorInChiefList = Array.from(document.querySelectorAll("b"))
      .some((element) => clean(element.textContent) === "Editor-in-Chief List");
    if (hasEditorInChiefList) {
      return "assignment-page";
    }

    const body = normalize(document.body?.innerText);
    const editorTokens = normalize(expectedEditor).split(/\s+/).filter(Boolean);
    const eicText = extractRoleText(body, "eic");
    const aeText = extractRoleText(body, "ae");
    const bothAssigned = editorTokens.every((token) => eicText.includes(token)) &&
      editorTokens.every((token) => aeText.includes(token));
    return bothAssigned ? "existing-assignments" : false;

    function extractRoleText(text, role) {
      const match = text.match(new RegExp(`(?:^|\\s)${role}:\\s*([^\\n]+)`, "i"));
      return match?.[1]?.trim() || "";
    }

    function clean(value) {
      return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }

    function normalize(value) {
      return (value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\u00a0/g, " ")
        .replace(/[(),]/g, " ")
        .replace(/[ \t]+/g, " ")
        .toLowerCase();
    }
  }, { expectedEditor: editorName }, { timeout });

  return destination.jsonValue();
}

export async function verifyFinalAssignments(page, editorName = DEFAULT_EDITOR_NAME) {
  return page.evaluate((expectedEditor) => {
    const body = normalize(document.body?.innerText);
    const editor = normalize(expectedEditor);
    const editorTokens = editor.split(/\s+/).filter(Boolean);
    const eicText = extractRoleText(body, "eic");
    const aeText = extractRoleText(body, "ae");
    return {
      editorInChiefAssigned: editorTokens.every((token) => eicText.includes(token)),
      associateEditorAssigned: editorTokens.every((token) => aeText.includes(token)),
      eicText,
      aeText,
    };

    function extractRoleText(text, role) {
      const match = text.match(new RegExp(`(?:^|\\s)${role}:\\s*([^\\n]+)`, "i"));
      return match?.[1]?.trim() || "";
    }

    function normalize(value) {
      return (value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\u00a0/g, " ")
        .replace(/[(),]/g, " ")
        .replace(/[ \t]+/g, " ")
        .toLowerCase();
    }
  }, editorName);
}
