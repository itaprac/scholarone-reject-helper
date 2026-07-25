export const DEFAULT_ASSESSMENT_MODEL = "gpt-5.6-terra";
export const DEFAULT_ASSESSMENT_REASONING_EFFORT = "medium";
export const ASSESSMENT_REASONING_EFFORTS = Object.freeze(["low", "medium", "high"]);

export function normalizeAssessmentReasoningEffort(value) {
  const normalized = String(value || DEFAULT_ASSESSMENT_REASONING_EFFORT)
    .trim()
    .toLowerCase();
  if (!ASSESSMENT_REASONING_EFFORTS.includes(normalized)) {
    throw new Error(
      `Reasoning effort musi mieć wartość: ${ASSESSMENT_REASONING_EFFORTS.join(", ")}.`
    );
  }
  return normalized;
}
