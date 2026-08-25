import path from "node:path";

export const INITIAL_ASSESSMENT_STAGE = "initial";
export const EIC_ASSESSMENT_STAGE = "eic";

export function isEicAssessment(config) {
  return config?.assessmentStage === EIC_ASSESSMENT_STAGE;
}

export function assessmentQueueLabel(config) {
  return isEicAssessment(config) ? "Awaiting EIC Assignment" : "Complete Checklist";
}

export function assessmentArtifactDirectory(config) {
  return path.join(
    config.logsDir,
    isEicAssessment(config) ? "eic-assessment" : "screening"
  );
}

export function assessmentProgressPath(config) {
  return path.join(assessmentArtifactDirectory(config), "live.progress.json");
}

export function assessmentWorkflowName(config) {
  return isEicAssessment(config) ? "eic-assessment" : "initial-assessment";
}
