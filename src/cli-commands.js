// Tłumaczenie komend na dotychczasowe flagi.
//
// Tryb wynikał wcześniej z kombinacji czterech niezależnych flag
// (--collect-metadata --assess-with-llm --scan-all-metadata
// --apply-assessment-decisions), a błędne zestawienie było wyłapywane dopiero
// wyjątkiem w czasie działania. Komenda ustala tryb jednym przełącznikiem;
// stare flagi zostają, bo używają ich zapisane skrypty npm.

export function translateRejectArgs(rest) {
  const args = ["--headed"];
  // Domyślnie dry-run: wysyłka wymaga jawnego --send.
  args.push(rest.includes("--send") ? "--save-and-send" : "--dry-run");

  // Raport można wskazać krótkim --from-report= albo starą flagą
  // --reject-from-report=; w obu przypadkach przebieg musi wymagać celów, żeby
  // nie zsunął się cicho do przechodzenia całej kolejki.
  const report = valueOf(rest, "from-report");
  if (report) {
    args.push(`--reject-from-report=${report}`);
  }
  if (report || rest.some((arg) => arg.startsWith("--reject-from-report=") || arg.startsWith("--reject-ids="))) {
    args.push("--require-targets");
  }

  return [...args, ...passThrough(rest, ["dry-run", "send", "from-report"])];
}

export function translateScreenArgs(rest) {
  // Wykonanie decyzji z zapisanego przebiegu jest osobną ścieżką: nie zbiera
  // metadanych i nie pyta modelu ponownie.
  const fromRun = valueOf(rest, "from-run");
  if (fromRun) {
    return ["--headed", `--from-run=${fromRun}`, ...passThrough(rest, ["dry-run", "live", "from-run"])];
  }

  const args = ["--headed", "--collect-metadata", "--assess-with-llm"];

  if (rest.includes("--live")) {
    args.push("--apply-assessment-decisions");
  } else {
    // Dry-run przechodzi całą kolejkę, bo nie wykonuje żadnej akcji.
    args.push("--scan-all-metadata");
  }

  return [...args, ...passThrough(rest, ["dry-run", "live"])];
}

export function translateReviewerArgs(rest) {
  const args = ["--select-reviewers", "--headed"];

  // --invite-all pozostaje jedynym potwierdzeniem realnej wysyłki zaproszeń.
  if (rest.includes("--invite")) {
    args.push("--invite-all");
  }

  const queue = valueOf(rest, "queue");
  if (queue) {
    args.push(`--reviewer-queue=${queue}`);
  }

  return [...args, ...passThrough(rest, ["prepare", "invite", "queue"])];
}

function passThrough(rest, consumed) {
  return rest.filter((arg) => {
    const name = arg.replace(/^--/, "").split("=")[0];
    return !consumed.includes(name);
  });
}

function valueOf(rest, name) {
  const match = rest.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : "";
}
