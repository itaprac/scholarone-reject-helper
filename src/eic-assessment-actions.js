import { submitScholarOneLinkByText } from "./core/dom.js";
import {
  navigateToAdminQueue,
  openManuscriptTabByIdAcrossQueuePages,
} from "./steps/queue.js";
import {
  assignEditor,
  verifyFinalAssignments,
  waitForAssignmentPage,
} from "./screening-approval.js";
import {
  commitImmediateReject,
  createAndSaveDecisionDraft,
  openImmediateDecision,
  selectImmediateReject,
} from "./eic-decision.js";

export async function assignEditorsFromAwaitingEic(page, {
  editorName,
  timeout = 20_000,
} = {}) {
  const alreadyOnAssignmentPage = await page.locator("b").filter({
    hasText: /^Editor-in-Chief List$/i,
  }).count() === 1;

  if (!alreadyOnAssignmentPage) {
    const opened = await submitScholarOneLinkByText(
      page,
      /^Assign\s+EIC$/i,
      /MANUSCRIPT_DETAILS_SHOW_TAB/i
    );
    if (!opened) {
      throw new Error("Nie znaleziono jednoznacznej akcji Assign EIC.");
    }
  }

  await waitForAssignmentPage(page, "Editor-in-Chief List", { timeout });
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
    throw new Error(`Nie potwierdzono przypisania obu ról dla ${editorName}.`);
  }

  return { editorInChief, associateEditor, assignmentVerification };
}

export async function applyEicAssessmentDecision(page, assessment, {
  editorName,
  manuscriptId,
  rejectMessage,
  timeout = 20_000,
} = {}) {
  const assignments = await assignEditorsFromAwaitingEic(page, { editorName, timeout });

  if (assessment.decision === "APPROVE") {
    return {
      completed: true,
      decision: "APPROVE",
      advancedToReviewers: true,
      assignments,
    };
  }

  if (assessment.decision !== "REJECT") {
    throw new Error(`Nieobsługiwana decyzja EIC assessment: ${assessment.decision}`);
  }

  if (!manuscriptId) {
    throw new Error("Brak ID manuskryptu potrzebnego do otwarcia Immediate Decision.");
  }

  const immediateDecision = await openImmediateDecisionFromQueue(page, manuscriptId);
  const selection = await selectImmediateReject(page);
  const draft = await createAndSaveDecisionDraft(page, rejectMessage);

  // Save and Close w popupie draftu odsyła stronę nadrzędną do zwykłych Details.
  // Przed Commit trzeba więc ponownie otworzyć Immediate Decision i ponownie
  // potwierdzić wybór Reject — inaczej przycisku Commit nie ma w DOM.
  await openImmediateDecisionFromQueue(page, manuscriptId);
  const selectionAfterDraft = await selectImmediateReject(page);
  const commit = await commitImmediateReject(page, rejectMessage);

  return {
    completed: true,
    decision: "REJECT",
    advancedToReviewers: false,
    assignments,
    immediateDecision,
    selection,
    selectionAfterDraft,
    draft,
    commit,
  };
}

async function openImmediateDecisionFromQueue(page, manuscriptId) {
  const queueReady = await navigateToAdminQueue(page, "Select Reviewers");
  if (!queueReady) {
    throw new Error("Nie udało się wrócić do kolejki Select Reviewers po przypisaniu EIC i AE.");
  }
  const decisionOpened = await openManuscriptTabByIdAcrossQueuePages(
    page,
    manuscriptId,
    /^Immediate\s+Decision$/i,
    { queueLabel: "Select Reviewers" }
  );
  if (!decisionOpened) {
    throw new Error(`Nie znaleziono Immediate Decision dla ${manuscriptId} w kolejce Select Reviewers.`);
  }
  return openImmediateDecision(page);
}
