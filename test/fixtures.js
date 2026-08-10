import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "scholarone"
);

// Snapshoty ScholarOne z podmienionymi danymi osobowymi. Odświeżanie:
// node scripts/anonymize-fixtures.js --source=~/Downloads
export const FIXTURES = Object.freeze({
  home: "home.html",
  admin: "admin-center.html",
  queue: "select-reviewers-queue.html",
  article: "reviewer-article.html",
  createAccount: "create-account.html",
  firstInviteAll: "invite-all-first.html",
  invitePopup: "invite-all-popup.html",
});

export function fixturePath(name) {
  const filename = FIXTURES[name] || name;
  return path.join(fixturesDir, filename);
}

export function fixtureUrl(name) {
  return pathToFileURL(fixturePath(name)).href;
}

export function readFixture(name) {
  return fs.readFileSync(fixturePath(name), "utf8");
}

export function fixtureExists(name) {
  return fs.existsSync(fixturePath(name));
}

// Snapshoty, których nie udało się odzyskać, dalej mogą być podane z zewnątrz
// przez SCHOLARONE_HTML_DIR — testy je wtedy uruchomią, a bez nich pomijają.
export function externalSnapshot(filename) {
  const directory = process.env.SCHOLARONE_HTML_DIR;
  if (!directory) return null;
  const absolutePath = path.join(directory, filename);
  return fs.existsSync(absolutePath) ? absolutePath : null;
}
