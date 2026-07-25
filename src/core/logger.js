import fsp from "node:fs/promises";
import path from "node:path";

// Log przebiegu w JSONL. Obok czytelnej linii w terminalu zapisuje pełny wpis,
// żeby dało się później odtworzyć przebieg krok po kroku.
export function createLogger(logFile, { prefix = "", echo = true } = {}) {
  return async function log(type, payload = {}) {
    const entry = { type, at: new Date().toISOString(), ...payload };
    await fsp.mkdir(path.dirname(logFile), { recursive: true });
    await fsp.appendFile(logFile, `${JSON.stringify(entry)}\n`, "utf8");
    if (echo) {
      console.log(`${prefix}${type} ${JSON.stringify(payload)}`);
    }
  };
}

export async function waitUntilInterrupted() {
  await new Promise((resolve) => {
    // Pusty interwał trzyma pętlę zdarzeń przy życiu, dopóki nie przyjdzie sygnał.
    const interval = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(interval);
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
