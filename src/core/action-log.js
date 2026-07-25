import fsp from "node:fs/promises";
import path from "node:path";

// Dziennik operacji nieodwracalnych: wysłanych maili i zaproszeń.
//
// Trzymany osobno od logów debugowych, bo odpowiada na inne pytanie — nie "co
// robił automat", tylko "czy ten artykuł już dostał wiadomość". Z tego powodu
// nie podlega czyszczeniu z retencji logów i jest dopisywalny, nigdy
// nadpisywany.
export function createActionLog(logsDir) {
  const file = path.join(logsDir, "actions.jsonl");

  return {
    file,

    async record({ runId, mode, manuscriptId, action, outcome, confirmed, detail = null }) {
      const entry = {
        at: new Date().toISOString(),
        runId,
        mode,
        manuscriptId: manuscriptId || null,
        action,
        outcome,
        confirmed: Boolean(confirmed),
        detail,
      };
      await fsp.mkdir(logsDir, { recursive: true });
      await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    },

    async readAll() {
      const content = await fsp.readFile(file, "utf8").catch(() => "");
      return content
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },

    // Czy ten manuskrypt dostał już potwierdzoną akcję tego typu.
    async wasCompleted(manuscriptId, action) {
      const entries = await this.readAll();
      return entries.some(
        (entry) =>
          entry.manuscriptId === manuscriptId &&
          entry.action === action &&
          entry.outcome === "sent" &&
          entry.confirmed
      );
    },
  };
}
