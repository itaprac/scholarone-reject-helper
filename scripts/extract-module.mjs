// Pomocnik refaktoru: wycina nazwane funkcje najwyższego poziomu z pliku i
// przenosi je do nowego modułu jako eksporty. Używany przy rozbijaniu
// auto-reject.js; nie jest częścią działania automatu.
import fs from "node:fs";

export function readFunctions(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const found = new Map();
  let name = null;
  let start = 0;
  let depth = 0;
  let started = false;

  lines.forEach((line, index) => {
    if (!name) {
      const match = line.match(/^(?:export )?(?:async )?function (\w+)\s*\(/);
      if (!match) return;
      name = match[1];
      start = index;
      depth = 0;
      started = false;
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (line.includes("{")) started = true;
    if (started && depth <= 0) {
      // Zabierz komentarz bezpośrednio nad funkcją.
      let head = start;
      while (head > 0 && /^\s*\/\//.test(lines[head - 1])) head--;
      found.set(name, { start: head, end: index, text: lines.slice(head, index + 1).join("\n") });
      name = null;
    }
  });

  return { lines, found };
}

export function extract(sourceFile, targetFile, names, { header = "", exportAll = true } = {}) {
  const { lines, found } = readFunctions(sourceFile);
  const missing = names.filter((n) => !found.has(n));
  if (missing.length) throw new Error(`Nie znaleziono: ${missing.join(", ")}`);

  const bodies = names.map((name) => {
    const text = found.get(name).text;
    return exportAll && !text.trimStart().startsWith("export ")
      ? text.replace(/^(\s*)(async )?function /m, `$1export $2function `)
      : text;
  });

  fs.writeFileSync(targetFile, `${header}${header ? "\n" : ""}${bodies.join("\n\n")}\n`, "utf8");

  const drop = new Set();
  for (const name of names) {
    const { start, end } = found.get(name);
    for (let i = start; i <= end; i++) drop.add(i);
  }

  const kept = lines.filter((_, index) => !drop.has(index));
  fs.writeFileSync(sourceFile, collapseBlankRuns(kept).join("\n"), "utf8");

  return { moved: names.length, remaining: kept.length };
}

function collapseBlankRuns(lines) {
  const out = [];
  for (const line of lines) {
    if (line.trim() === "" && out.at(-1)?.trim() === "") continue;
    out.push(line);
  }
  return out;
}
