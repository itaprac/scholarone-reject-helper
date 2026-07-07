# ScholarOne auto-reject helper

Automat Playwright do sprawdzania kolejki `Complete Checklist` w ScholarOne i odrzucania wybranych manuskryptow wedlug prostych regul.

## Co trzeba miec

Node.js 18 lub nowszy.

Potem w katalogu projektu:

```bash
npm install
npm run install-browsers
```

`npm install` instaluje Playwrighta z `package.json`, a `npm run install-browsers`
pobiera Chromium uzywane przez automat.

## Pierwsza konfiguracja

Skopiuj plik przykladowy:

```bash
cp .env.example .env
```

W pliku `.env` wpisz login i haslo:

```bash
AUTO_LOGIN=true
LOGIN_USERNAME=twoj-login
LOGIN_PASSWORD=twoje-haslo
```

Alternatywnie mozesz trzymac dane w `login.env`:

```bash
LOGIN_CREDENTIALS_FILE=login.env
```

`login.env` moze miec format:

```bash
LOGIN_USERNAME=twoj-login
LOGIN_PASSWORD=twoje-haslo
```

## Jak dziala decyzja

Skrypt zawsze zostawia manuskrypty konczace sie na `.R` + liczba, np. `.R1`,
`.R2`, `.R3` albo `.R10`.

Pozostale manuskrypty sa kandydatami do rejectu, jesli:

- maja komunikat `High rate of unusual activity`, albo
- `Date submitted` jest starsze niz ustawiony limit, domyslnie 30 dni.

## Najprostsze uruchomienie przez UI

```bash
npm run ui
```

Potem otworz:

```text
http://localhost:3131
```

W panelu mozesz:

- odpalic `Run dry run`,
- odpalic normalny `Run + reject`,
- wybrac raport z dry-runu i kliknac `Reject selected report`,
- zmienic tekst maila w `Settings`,
- zapisac ustawienia do `ui-settings.json`.

Przed akcja, ktora naprawde odrzuca artykuly, UI pokazuje dodatkowe okno potwierdzenia.

Pierwsze uruchomienie otwiera osobny profil Chromium w `playwright-profile/`.
Przy pierwszym logowaniu ScholarOne moze poprosic o kod z maila. Wpisz kod i
zaznacz opcje `Remember this device`, zeby kolejne uruchomienia nie wymuszaly
ponownie weryfikacji.

## Dry-run z terminala

Dry-run niczego nie odrzuca. Tylko sprawdza manuskrypty i zapisuje raport JSON/CSV w `logs/reports`.

```bash
npm run dryrun -- --max-checked=50 --submitted-older-than-days=30 --slow-mo=500
```

## Normalny run z terminala

Ten tryb od razu wykonuje reject dla pasujacych manuskryptow.

```bash
npm run reject -- --max-checked=50 --max-rejected=4 --slow-mo=800
```

Jesli chcesz zostawic okno przegladarki otwarte po runie:

```bash
npm run reject -- --max-checked=50 --max-rejected=4 --slow-mo=800 --keep-open
```

`--max-rejected=4` jest bezpiecznym limitem do testowania. Jesli go nie podasz, skrypt nie ma limitu liczby rejectow poza `--max-checked`.

## Reject z raportu


1. odpal dry-run,
2. sprawdz raport w UI albo w `logs/reports`,
3. odpal reject z wybranego raportu.

```bash
npm run reject:from-report -- --reject-from-report=logs/reports/RUN_ID.json --slow-mo=800
```

Skrypt wyszuka kazdy ID z raportu, ponownie sprawdzi reguly i dopiero wtedy odrzuci. Obok raportu powstaje plik `*.progress.json`, dzieki czemu ponowne odpalenie pominie juz obsluzone manuskrypty. (Zajmuje więcej czasu)

## Przydatne argumenty

- `--max-checked=50` - ile manuskryptow sprawdzic w danym runie.
- `--max-rejected=4` - maksymalna liczba rejectow w danym runie.
- `--submitted-older-than-days=30` - prog wieku zgłoszenia.
- `--queue-start-page=2` - start od strony listy, np. `2` oznacza `11-20`.
- `--slow-mo=800` - spowolnienie klikniec Playwrighta w ms.
- `--keep-open` - zostawia przegladarke otwarta po zakonczeniu.
- `--start-url="https://mc.manuscriptcentral.com/kes?PARAMS=..."` - nadpisuje URL startowy.
- `--reject-message="..."` - nadpisuje tekst maila dla danego runu.
- `--reject-message-file=reject-message.txt` - bierze tekst maila z pliku.
