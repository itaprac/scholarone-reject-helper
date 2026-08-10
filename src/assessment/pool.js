// Pula zadań z ograniczoną równoległością.
//
// W dry-runie przeglądarka tylko czyta, więc ocena nie musi blokować przejścia
// do kolejnego artykułu. Wcześniej pętla wyglądała tak: otwórz artykuł →
// skopiuj abstrakt → czekaj na model → następny; dwa najwolniejsze zasoby stały
// na przemian bezczynnie.
//
// W trybie live pula nie jest używana: decyzja musi być znana, zanim automat
// kliknie cokolwiek na otwartej stronie.
export function createTaskPool({ concurrency = 3 } = {}) {
  const limit = Math.max(1, concurrency);
  const running = new Set();
  const results = [];

  return {
    get size() {
      return results.length;
    },
    get pending() {
      return running.size;
    },

    // Zwraca indeks zadania, nie jego obietnicę. Gdyby zwracała obietnicę,
    // naturalne `await pool.add(...)` po stronie wywołującego czekałoby na
    // zakończenie zadania i równoległość spadłaby do jednego. Po wyniki sięga
    // się przez drain().
    async add(task) {
      // Pętla, a nie pojedyncze await: wyścig kończy się, gdy dowolne zadanie
      // się rozstrzygnie, ale usunięcie go ze zbioru jest mikrozadaniem, więc
      // po jednym przebiegu miejsce nie musi być jeszcze wolne.
      while (running.size >= limit) {
        await Promise.race(running);
      }

      const index = results.length;
      results.push({ status: "pending" });

      const settled = (async () => {
        try {
          results[index] = { status: "fulfilled", value: await task() };
        } catch (error) {
          results[index] = { status: "rejected", reason: error };
        } finally {
          running.delete(settled);
        }
      })();

      running.add(settled);
      return index;
    },

    async drain() {
      while (running.size > 0) {
        await Promise.race(running);
      }
      return {
        results,
        failures: results.filter((entry) => entry.status === "rejected").length,
      };
    },
  };
}
