// Wykrywa wywołania funkcji z mniejszą liczbą argumentów, niż wymaga
// sygnatura. Przy rozbijaniu monolitu część funkcji dostała nowe parametry
// (config, runId, reportDir) i nie wszystkie wywołania zostały zaktualizowane —
// a taki błąd jest niewidoczny dla lintera i wychodzi dopiero w czasie
// działania, często na końcu przebiegu.
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "logs", "playwright-profile"]);

export function scanArity(roots) {
  const files = roots.flatMap((root) => walk(root));
  const signatures = new Map();

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/^(?:export )?(?:async )?function (\w+)\s*\(([^)]*)\)/gm)) {
      const [, name, params] = match;
      const required = countRequired(params);
      const known = signatures.get(name);
      // Ta sama nazwa bywa zdefiniowana w kilku modułach (np. lokalne
      // ensureLoggedIn w select-reviewers.js obok rdzeniowego). Bierzemy
      // najmniej wymagającą sygnaturę, żeby nie zgłaszać poprawnych wywołań.
      if (!known || required < known.required) {
        signatures.set(name, { file, required });
      }
    }
  }

  const problems = [];

  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");

    lines.forEach((line, index) => {
      // Pomijamy definicje, importy i komentarze — interesują nas wywołania.
      if (/^\s*(export )?(async )?function /.test(line)) return;
      if (/^\s*(import|export)\b/.test(line)) return;
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
      // Skrócona definicja metody w obiekcie: `describe() {` to nie wywołanie.
      if (/^\s*(async\s+)?\w+\s*\([^)]*\)\s*\{\s*$/.test(line)) return;

      for (const match of line.matchAll(/(?<![.\w])(\w+)\s*\(/g)) {
        const name = match[1];
        const signature = signatures.get(name);
        if (!signature || signature.required === 0) continue;

        const args = readArguments(line, match.index + match[0].length);
        // null = wywołanie rozciąga się na kolejne linie; nie zgadujemy.
        if (args === null) continue;
        if (args < signature.required) {
          problems.push({
            file,
            line: index + 1,
            name,
            given: args,
            required: signature.required,
            source: line.trim().slice(0, 100),
          });
        }
      }
    });
  }

  return problems;
}

function countRequired(params) {
  const parts = splitTopLevel(params);
  let required = 0;
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    // Parametr z wartością domyślną albo rest nie jest wymagany.
    if (text.startsWith("...") || text.includes("=")) break;
    required++;
  }
  return required;
}

function readArguments(line, start) {
  let depth = 1;
  let index = start;
  let content = "";

  while (index < line.length) {
    const char = line[index];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        const trimmed = content.trim();
        return trimmed === "" ? 0 : splitTopLevel(trimmed).length;
      }
    }
    content += char;
    index++;
  }

  return null;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  let quote = null;

  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if ("([{".includes(char)) depth++;
    if (")]}".includes(char)) depth--;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) parts.push(current);
  return parts;
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    return entry.name.endsWith(".js") ? [target] : [];
  });
}
