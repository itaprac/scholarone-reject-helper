import path from "node:path";
import { runCodexAssessment } from "../llm-assessment.js";
import { projectRoot } from "../config/defaults.js";
import { createAssessmentCache } from "./cache.js";
import { assessmentArtifactDirectory } from "../assessment-stage.js";

// Warstwa pośrednia między workflow a modelem.
//
// Do tej pory ocena była zrośnięta z Codex CLI: flagi procesu, parsowanie JSONL
// ze stdout, plik --output-last-message i liczenie tokenów ze zdarzeń
// turn.completed były wplecione wprost w przebieg. Tutaj workflow widzi tylko
// assess(metadata) i nie wie, co jest po drugiej stronie — dzięki temu cache i
// ewentualny drugi adapter nie wymagają dotykania pętli screeningu.
export function createAssessmentProvider(config, { runId, log = async () => undefined } = {}) {
  const cache = createAssessmentCache({
    directory: path.join(config.logsDir, "assessment-cache"),
    enabled: config.assessmentCache !== false,
  });

  const options = {
    instructions: config.assessmentPrompt,
    model: config.assessmentModel,
    reasoningEffort: config.assessmentReasoningEffort,
    timeoutMs: config.assessmentTimeoutSeconds * 1000,
    cwd: projectRoot,
  };

  return {
    name: "codex-cli",

    outputPathFor(manuscriptId) {
      return path.join(assessmentArtifactDirectory(config), `${runId}-${manuscriptId}-llm.json`);
    },

    async assess(metadata) {
      const cached = await cache.read(metadata, options);
      if (cached) {
        await log("llm_assessment_cache_hit", {
          manuscriptId: metadata.manuscriptId,
          cachedAt: cached.cachedAt,
        });
        return cached;
      }

      const outputPath = this.outputPathFor(metadata.manuscriptId);
      const assessment = await runCodexAssessment(metadata, { ...options, outputPath });
      await cache.write(metadata, options, assessment);
      return { ...assessment, cached: false };
    },
  };
}
