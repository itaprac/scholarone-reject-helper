#!/usr/bin/env node
// Jedyny punkt wejścia automatu. Nic tu nie liczy i nic nie klika — rozpoznaje
// komendę i przekazuje sterowanie dalej.
//
//   scholarone reject     --dry-run | --send [--from-report=...]
//   scholarone screen     --dry-run | --live
//   scholarone reviewers  --prepare | --invite [--queue=combined]
//   scholarone doctor
//   scholarone ui
//
// Stare wywołania oparte wprost na flagach (--select-reviewers, --dry-run,
// --collect-metadata) nadal działają, bo używają ich zapisane skrypty npm.
import {
  translateEicScreenArgs,
  translateRejectArgs,
  translateReviewerArgs,
  translateScreenArgs,
} from "../src/cli-commands.js";

const argv = process.argv.slice(2);
const COMMANDS = new Set(["reject", "screen", "eic-screen", "reviewers", "doctor", "ui", "help"]);
const command = COMMANDS.has(argv[0]) ? argv[0] : null;
const args = command ? argv.slice(1) : argv;

try {
  await dispatch(command, args);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

async function dispatch(name, rest) {
  if (name === "help" || (!name && rest.includes("--help"))) {
    return printHelp();
  }

  if (name === "doctor") {
    const { formatDoctorReport, runDoctorChecks } = await import("../src/doctor.js");
    const checks = await runDoctorChecks();
    console.log(formatDoctorReport(checks));
    if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
    return undefined;
  }

  if (name === "ui") {
    return import("../src/ui-server.js");
  }

  if (name === "reviewers" || (!name && rest.includes("--select-reviewers"))) {
    const { runSelectReviewers } = await import("../src/select-reviewers.js");
    return runSelectReviewers(name === "reviewers" ? translateReviewerArgs(rest) : rest);
  }

  const { runReject } = await import("../src/run-reject.js");
  if (name === "reject") return runReject(translateRejectArgs(rest));
  if (name === "screen") return runReject(translateScreenArgs(rest));
  if (name === "eic-screen") return runReject(translateEicScreenArgs(rest));
  return runReject(rest);
}

function printHelp() {
  console.log(`ScholarOne helper

  scholarone reject --dry-run              sprawdź kolejkę bez wysyłania
  scholarone reject --send                 odrzuć pasujące manuskrypty
  scholarone reject --send --from-report=PLIK
  scholarone screen --dry-run              ocena LLM bez akcji w ScholarOne
  scholarone screen --live                 wykonaj decyzje oceny
  scholarone eic-screen --dry-run          druga ocena z Awaiting EIC Assignment
  scholarone eic-screen --live             przypisz edytorów i wykonaj decyzje
  scholarone reviewers --prepare           dobierz recenzentów bez wysyłki
  scholarone reviewers --invite            dobierz i wyślij zaproszenia
  scholarone doctor                        sprawdź środowisko przed przebiegiem
  scholarone ui                            panel na http://localhost:3131

Pozostałe flagi (--max-checked=, --slow-mo=, --keep-open, ...) działają jak dotąd
i są przekazywane dalej bez zmian.`);
  return undefined;
}
