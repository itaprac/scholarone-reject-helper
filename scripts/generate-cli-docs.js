// Generuje docs/cli.md z definicji opcji. Referencja flag pisana ręcznie
// zawsze w końcu rozjeżdża się z kodem — ta nie może, bo czyta to samo źródło,
// z którego bierze się parser i walidacja.
//
//   node scripts/generate-cli-docs.js [--check]

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIELDS, RUN_MODES } from "../src/config/options.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(projectRoot, "docs", "cli.md");
const checkOnly = process.argv.includes("--check");

const MODE_LABELS = {
  dryrun: "reject --dry-run",
  live: "reject --send",
  "send-from-report": "reject --send --from-report=...",
  screening: "screen",
  "eic-assessment": "eic-screen",
  "reviewers-prepare": "reviewers --prepare",
  "reviewers-invite": "reviewers --invite",
};

const content = render();

if (checkOnly) {
  const current = await fsp.readFile(target, "utf8").catch(() => "");
  if (current !== content) {
    console.error("docs/cli.md jest nieaktualny — uruchom: node scripts/generate-cli-docs.js");
    process.exit(1);
  }
  console.log("docs/cli.md aktualny");
} else {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
  console.log(`zapisano ${path.relative(projectRoot, target)}`);
}

function render() {
  const lines = [
    "<!-- Plik generowany. Nie edytuj ręcznie:",
    "     node scripts/generate-cli-docs.js -->",
    "",
    "# Referencja komend i flag",
    "",
    "```",
    "scholarone reject     --dry-run | --send [--from-report=PLIK]",
    "scholarone screen     --dry-run | --live",
    "scholarone eic-screen --dry-run | --live [--from-run=PLIK]",
    "scholarone reviewers  --prepare | --invite [--queue=combined|select|invite]",
    "scholarone doctor",
    "scholarone ui",
    "```",
    "",
    "Domyślny wariant każdej komendy jest bezpieczny. Operacja nieodwracalna",
    "wymaga jawnego `--send`, `--live` albo `--invite`.",
    "",
    "## Opcje według trybu",
    "",
  ];

  for (const [mode, definition] of Object.entries(RUN_MODES)) {
    lines.push(`### ${MODE_LABELS[mode] || mode}`, "");
    lines.push("| Flaga | Typ | Domyślnie | Opis |", "|---|---|---|---|");

    for (const key of [...definition.fields, ...(definition.trailing || [])]) {
      lines.push(row(key));
    }
    lines.push("");
  }

  lines.push(
    "## Opcje wspólne",
    "",
    "| Flaga | Opis |",
    "|---|---|",
    "| `--headed` | okno przeglądarki widoczne (domyślne dla komend) |",
    "| `--headless` | bez okna |",
    "| `--keep-open` | zostaw przeglądarkę otwartą po zakończeniu |",
    "| `--debug-screenshots` | zapisuj zrzut z każdego kroku, nie tylko przy błędach |",
    "| `--profile-dir=` | katalog profilu Chromium |",
    "| `--logs-dir=` | katalog logów |",
    "| `--cdp=` | podłącz się do działającego Chrome zamiast własnego profilu |",
    "| `--browser-channel=` | kanał przeglądarki, np. `chrome` |",
    "",
    "## Bezpieczniki",
    "",
    "| Flaga | Opis |",
    "|---|---|",
    "| `--max-rejected=N` | limit odrzuceń w przebiegu |",
    "| `--max-live-actions=N` | limit operacji nieodwracalnych w assessment live (domyślnie 25) |",
    "| `--require-targets` | przebieg musi dostać listę celów, inaczej przerywa |",
    "",
    "## Ocena LLM",
    "",
    "| Flaga | Opis |",
    "|---|---|",
    "| `--assessment-concurrency=N` | ile ocen naraz w dry-runie (domyślnie 3) |",
    "| `--no-cache` | wymuś świeżą ocenę, pomijając cache |",
    "| `--assessment-prompt-file=` | prompt z pliku |",
    "| `--screening-reject-message-file=` | treść wiadomości odrzucenia z pliku |",
    "| `--assessment-stage=eic` | użyj Awaiting EIC Assignment i drugiego promptu |",
    "",
    "Każda flaga ma odpowiednik w `.env` — kolejność źródeł to: flaga CLI,",
    "zmienna środowiskowa, wartość domyślna.",
    ""
  );

  return lines.join("\n");
}

function row(key) {
  const definition = FIELDS[key];
  const fallback = definition.default === "" || definition.default === undefined
    ? "—"
    : String(definition.default);
  const type = definition.type === "int" && definition.min !== undefined
    ? `int ≥ ${definition.min}`
    : definition.type === "choice"
      ? definition.choices.join(" \\| ")
      : definition.type;

  return `| \`--${definition.flag}\` | ${type} | ${fallback} | ${definition.help || definition.label} |`;
}
