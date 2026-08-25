# ScholarOne helper

Automat Playwright do czterech niezależnych zadań w ScholarOne:

| Tryb | Co robi | Dokumentacja |
|---|---|---|
| **reject** | sprawdza kolejkę `Complete Checklist` i odrzuca pasujące manuskrypty | [docs/reject.md](docs/reject.md) |
| **screen** | wstępna ocena tytułu i abstraktu przez LLM, opcjonalnie z wykonaniem decyzji | [docs/screening.md](docs/screening.md) |
| **eic-screen** | druga, ostrzejsza ocena z `Awaiting EIC Assignment` | [docs/eic-assessment.md](docs/eic-assessment.md) |
| **reviewers** | dobór i zapraszanie recenzentów z `Select Reviewers` | [docs/reviewers.md](docs/reviewers.md) |

Pełna lista flag: [docs/cli.md](docs/cli.md).

## Instalacja

Potrzebny Node.js 20 lub nowszy.

```bash
npm install
npm run install-browsers
cp .env.example .env
```

W `.env` wpisz dane logowania:

```bash
AUTO_LOGIN=true
LOGIN_USERNAME=twoj-login
LOGIN_PASSWORD=twoje-haslo
```

Sprawdź, czy wszystko jest na miejscu:

```bash
npm run doctor
```

Komenda weryfikuje wersję Node, pobrane Chromium, logowanie Codex CLI, dane
logowania i katalog logów. Robi to w dwie sekundy — bez niej o brakującym
elemencie dowiesz się dopiero w połowie przebiegu.

## Pierwszy przebieg

Najprościej przez panel:

```bash
npm run ui
```

Potem otwórz `http://localhost:3131`.

Albo z terminala — **domyślny wariant każdej komendy jest bezpieczny**, czyli
niczego nie wysyła:

```bash
node bin/scholarone.js reject --dry-run      # tylko sprawdza i zapisuje raport
node bin/scholarone.js screen --dry-run      # ocenia, nie klika w ScholarOne
node bin/scholarone.js eic-screen --dry-run  # druga ocena, nie klika w ScholarOne
node bin/scholarone.js reviewers --prepare   # dobiera recenzentów, nie zaprasza
```

Realna, nieodwracalna akcja wymaga jawnego przełącznika: `--send`, `--live`
albo `--invite`.

Pierwsze uruchomienie otwiera osobny profil Chromium w `playwright-profile/`.
ScholarOne może poprosić o kod z maila — wpisz go i zaznacz `Remember this
device`, żeby kolejne przebiegi nie wymagały weryfikacji.

## Zasada decyzji

Manuskrypty kończące się na `.R` + liczba (`.R1`, `.R2`, `.R10`) są zawsze
zostawiane. Pozostałe są kandydatami do odrzucenia, jeśli mają komunikat
`High rate of unusual activity` albo `Date submitted` starsze niż ustawiony
limit (domyślnie 30 dni).

## Bezpieczniki

Automat wysyła prawdziwe maile i prawdziwe zaproszenia. Chronią przed tym:

- **dry-run domyślnie** — wysyłka wymaga osobnego przełącznika,
- **limit operacji** — `--max-rejected` dla odrzucania, `--max-live-actions`
  (domyślnie 25) dla screeningu live; sprawdzany *przed* akcją, nie po niej,
- **weryfikacja skutku** — samo zamknięcie popupu nie liczy się jako sukces;
  automat sprawdza statusy i liczniki,
- **pliki postępu** — ponowne uruchomienie pomija manuskrypty już obsłużone;
  akcja rozpoczęta i niepotwierdzona zatrzymuje przebieg do ręcznego sprawdzenia,
- **`logs/actions.jsonl`** — dziennik wysłanych wiadomości i zaproszeń, osobny
  od logów debugowych i niepodlegający czyszczeniu.

## Logi

```text
logs/
  actions.jsonl          dziennik operacji nieodwracalnych (nie jest czyszczony)
  <runId>.jsonl          pełny log przebiegu
  reports/               raporty dry-runu, wejście dla reject --from-report
  screening/             wyniki oceny LLM + CSV
  eic-assessment/        wyniki drugiej oceny LLM + CSV
  screenshots/<runId>/   zrzuty ekranu
```

Zrzuty domyślnie powstają tylko przy błędach i przy operacjach
nieodwracalnych. Pełny zapis każdego kroku włącza `--debug-screenshots`.

Sprzątanie:

```bash
npm run logs:prune -- --dry-run   # pokaż, co zniknie
npm run logs:prune
```

Raporty i wyniki screeningu są danymi, nie logami — znikają tylko po jawnym
`--include-reports` / `--include-screening`.

## Rozwój

```bash
npm run check     # lint + testy
npm test
```

Testy offline działają na snapshotach ScholarOne z `test/fixtures/scholarone/`
z podmienionymi danymi osobowymi. Odświeżenie po zapisaniu nowych stron:

```bash
node scripts/anonymize-fixtures.js --source=~/Downloads
```

Trzy testy są pomijane, bo ich snapshotów nie udało się odzyskać. Uruchomią się,
jeśli wskażesz katalog z własnymi zrzutami przez `SCHOLARONE_HTML_DIR`.
