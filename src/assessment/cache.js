import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

// Ocena tego samego artykułu tym samym promptem i modelem daje ten sam wynik, a
// kosztuje za każdym razem. Przy dobieraniu promptu to główny koszt przebiegu,
// bo kolejka się nie zmienia — zmienia się tylko instrukcja.
//
// Klucz obejmuje wszystko, co wpływa na odpowiedź: treść artykułu, prompt,
// model i poziom reasoningu. Zmiana czegokolwiek z tego to nowy wpis.
export function assessmentCacheKey(metadata, options) {
  const material = JSON.stringify([
    metadata.manuscriptId,
    metadata.title,
    metadata.abstract,
    options.instructions,
    options.model,
    options.reasoningEffort,
  ]);
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export function createAssessmentCache({ directory, enabled = true } = {}) {
  return {
    enabled,

    async read(metadata, options) {
      if (!enabled) return null;
      const file = entryPath(directory, assessmentCacheKey(metadata, options));
      try {
        const entry = JSON.parse(await fsp.readFile(file, "utf8"));
        // Trafienie oznacza wynik, nie nowe wywołanie — zerujemy zużycie
        // tokenów, żeby podsumowanie przebiegu nie doliczało go drugi raz.
        return {
          ...entry.assessment,
          cached: true,
          cachedAt: entry.at,
          durationMs: 0,
          usage: { available: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      } catch {
        return null;
      }
    },

    async write(metadata, options, assessment) {
      if (!enabled || !assessment) return;
      const file = entryPath(directory, assessmentCacheKey(metadata, options));
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(
        file,
        `${JSON.stringify({
          at: new Date().toISOString(),
          manuscriptId: metadata.manuscriptId,
          assessment: { ...assessment, cached: false },
        }, null, 2)}\n`,
        "utf8"
      );
    },
  };
}

function entryPath(directory, key) {
  return path.join(directory, `${key}.json`);
}
