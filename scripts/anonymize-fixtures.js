// Przenosi snapshoty ScholarOne do test/fixtures/scholarone/, zamieniając dane
// osobowe na deterministyczne dane testowe. Zachowuje strukturę HTML, skrypty
// inline i parametry PARAMS=xik_..., bo to na nich opierają się testy offline.
//
//   node scripts/anonymize-fixtures.js [--source=~/Downloads] [--check]
//
// Mapowanie jest deterministyczne i wspólne dla wszystkich plików, więc ta sama
// osoba dostaje tę samą tożsamość zastępczą w każdym snapshocie.

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { readAllReviewerList, readCandidatePage } from "../src/select-reviewers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(projectRoot, "test", "fixtures", "scholarone");

const FIXTURES = {
  "home.html": "ScholarOne Manuscripts.html",
  "admin-center.html": "admin_center.html",
  "select-reviewers-queue.html": "Select_reviewers_list.html",
  "reviewer-article.html": "selecxt_reviweers_article.html",
  "create-account.html": "nwe_acc_add.html",
  "invite-all-first.html": "invite_all_first.html",
  "invite-all-popup.html": "ivniteall_popup.html",
};

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SURNAMES = [
  "Kowalska", "Nowak", "Wisniewski", "Wojcik", "Kowalczyk", "Kaminska",
  "Lewandowski", "Zielinska", "Szymanski", "Dabrowska", "Piotrowski",
  "Grabowska", "Nowicki", "Pawlowska", "Michalski", "Adamczyk",
];
const FORENAMES = [
  "Anna", "Piotr", "Maria", "Tomasz", "Katarzyna", "Marek", "Agnieszka",
  "Pawel", "Magdalena", "Krzysztof", "Barbara", "Jan", "Ewa", "Andrzej",
  "Joanna", "Michal",
];

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [flag, value = "true"] = arg.replace(/^--/, "").split("=");
    return [flag, value];
  })
);
const sourceDir = (args.source || path.join(process.env.HOME || "", "Downloads")).replace(/^~/, process.env.HOME || "");
const checkOnly = args.check === "true";

const browser = await chromium.launch({ headless: true });
const sources = new Map();
const people = new Set();
const emails = new Set();

try {
  // Pierwsze przejście: zbierz tożsamości ze wszystkich plików naraz, żeby
  // mapowanie było spójne między snapshotami.
  for (const [target, original] of Object.entries(FIXTURES)) {
    const absolutePath = path.join(sourceDir, original);
    const html = await fsp.readFile(absolutePath, "utf8").catch(() => null);
    if (html === null) {
      console.warn(`pominięto (brak pliku): ${original}`);
      continue;
    }
    sources.set(target, html);

    for (const email of html.match(EMAIL_PATTERN) || []) {
      emails.add(email);
    }
    for (const name of await collectNames(browser, absolutePath, html)) {
      people.add(name);
    }
  }
} finally {
  await browser.close();
}

const emailMap = buildMap([...emails].sort(), (index) => `reviewer${index + 1}@example.org`);
const nameMap = buildMap([...people].sort(), (index) => {
  const surname = SURNAMES[index % SURNAMES.length];
  const forename = FORENAMES[index % FORENAMES.length];
  const suffix = index >= SURNAMES.length ? String(Math.floor(index / SURNAMES.length) + 1) : "";
  return { surname: `${surname}${suffix}`, forename };
});

let failures = 0;

for (const [target, html] of sources) {
  const scrubbed = scrub(html);
  const leftovers = findLeftovers(scrubbed);

  if (leftovers.length > 0) {
    failures++;
    console.error(`${target}: pozostały dane osobowe -> ${leftovers.slice(0, 5).join(", ")}`);
    continue;
  }

  if (checkOnly) {
    console.log(`${target}: czysty`);
    continue;
  }

  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(path.join(outputDir, target), scrubbed, "utf8");
  console.log(`${target}: zapisany (${(scrubbed.length / 1024).toFixed(0)} KB)`);
}

console.log(`\nzamienione tożsamości: ${nameMap.size}, maile: ${emailMap.size}`);
if (failures > 0) {
  process.exitCode = 1;
}

// Nazwiska czytamy tymi samymi parserami, których używa automat — dzięki temu
// anonimizacja nie może przeoczyć pola, które aplikacja traktuje jako nazwisko.
async function collectNames(browserInstance, absolutePath, html) {
  const found = new Set();

  // Metadane Pendo zawierają tożsamość zalogowanego administratora.
  for (const match of html.matchAll(/first_name:"([^"]*)"/g)) addName(found, match[1]);
  for (const match of html.matchAll(/last_name:"([^"]*)"/g)) addName(found, match[1]);
  for (const match of html.matchAll(/name="PERSON_(?:FIRST|LAST)NAME"[^>]*value="([^"]*)"/gi)) {
    addName(found, match[1]);
  }

  const page = await browserInstance.newPage();
  try {
    await page.goto(pathToFileURL(absolutePath).href, { waitUntil: "domcontentloaded" });
    for (const reviewer of await readAllReviewerList(page).catch(() => [])) {
      addName(found, reviewer?.name);
    }
    for (const candidate of await readCandidatePage(page).catch(() => [])) {
      addName(found, candidate?.name);
      addName(found, candidate?.firstName);
      addName(found, candidate?.lastName);
    }
  } finally {
    await page.close();
  }

  return found;
}

function addName(target, value) {
  const text = String(value || "").trim();
  // Jednoliterowe inicjały i puste pola nie identyfikują nikogo, a ich globalna
  // podmiana zniszczyłaby resztę dokumentu.
  if (text.length < 3) return;
  for (const part of text.split(/\s*,\s*|\s+/)) {
    if (part.length >= 3 && /[a-zA-ZÀ-ž]/.test(part)) target.add(part);
  }
  target.add(text);
}

function buildMap(values, factory) {
  const map = new Map();
  values.forEach((value, index) => map.set(value, factory(index)));
  return map;
}

function scrub(html) {
  let output = html;

  for (const [email, replacement] of emailMap) {
    output = replaceAllVariants(output, email, replacement);
  }

  // Najdłuższe najpierw: "Kowalski, Jan" musi zniknąć przed samym "Kowalski".
  const names = [...nameMap.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const { surname, forename } = nameMap.get(name);
    const replacement = name.includes(",") ? `${surname}, ${forename}` : surname;
    output = replaceAllVariants(output, name, replacement);
  }

  // Identyfikatory osób i sesji analitycznej. ScholarOne wstrzykuje person_id
  // w dwóch wariantach: gołym (Pendo) i w cudzysłowach (dataLayer GTM).
  output = output.replace(/(['"]?person_id['"]?\s*:\s*)['"]?\d+['"]?/g, "$1'100000001'");
  output = output.replace(/visitor:\s*\{\s*id:"[^"]*"/g, 'visitor: {id:"admin@example.org"');

  return output;
}

// ScholarOne serwuje te same dane w kilku kodowaniach naraz: surowo, z encjami
// HTML i z escapowanymi separatorami w javascript:.
function replaceAllVariants(html, needle, replacement) {
  const variants = new Set([
    needle,
    needle.replace(/@/g, "&#64;"),
    needle.replace(/\./g, "\\-"),
    needle.replace(/-/g, "\\-"),
    encodeURIComponent(needle),
    escapeHtml(needle),
  ]);

  let output = html;
  for (const variant of variants) {
    if (!variant) continue;
    output = output.split(variant).join(replacement);
  }
  return output;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findLeftovers(html) {
  const leftovers = new Set();

  for (const email of html.match(EMAIL_PATTERN) || []) {
    if (!/@example\.(org|com|edu)$/i.test(email)) leftovers.add(email);
  }
  for (const name of nameMap.keys()) {
    if (html.includes(name)) leftovers.add(name);
  }
  // Identyfikator konta administratora bywa powtórzony w kilku blokach
  // analitycznych naraz — każdy musi zniknąć.
  for (const match of html.matchAll(/['"]?person_id['"]?\s*:\s*['"]?(\d+)['"]?/g)) {
    if (match[1] !== "100000001") leftovers.add(`person_id:${match[1]}`);
  }

  return [...leftovers];
}
