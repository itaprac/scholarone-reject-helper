# ScholarOne reject and reviewer-selection helper

Automat Playwright ma dwa niezależne tryby:

- dotychczasowe sprawdzanie kolejki `Complete Checklist` i kontrolowane odrzucanie,
- wybór recenzentów z `Manage → Admin Center → Select Reviewers`.

Tryb odrzucania zachowuje dotychczasowe komendy i działanie.

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

- przelaczac sie miedzy osobnymi kartami `Auto-reject` i `Reviewers`,
- odpalic `Run dry run`,
- odpalic normalny `Run + reject`,
- wybrac raport z dry-runu i kliknac `Reject selected report`,
- przygotowac reviewerow dla jednego artykulu bez finalnego wyslania,
- wybrac i zaprosic reviewerow dla kilku artykulow kolejno w jednej partii,
- zmienic tekst maila w `Settings`,
- zapisac ustawienia do `ui-settings.json`.

Przed akcja, ktora naprawde odrzuca artykuly, UI pokazuje dodatkowe okno potwierdzenia.
Przycisk `Select + invite batch` jest jawnym uruchomieniem wysylki i nie wymaga
wpisywania `confirm`. Automat konczy jeden artykul, sprawdza statusy/liczniki i
dopiero potem przechodzi do kolejnego.

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

## Wybór recenzentów — tryb bezpieczny

Poniższa komenda otwiera pierwszy artykuł z kolejki `Select Reviewers`, odczytuje
całą `Reviewer List`, dodaje brakujących unikalnych kandydatów do limitu 10,
otwiera pierwszy popup `Invite All` i zatrzymuje się przed drugim przyciskiem,
który naprawdę wysyła zaproszenia:

```bash
npm run select-reviewers -- --reviewers-per-paper=10 --slow-mo=500 --keep-open
```

Po przerwaniu przebiegu już po dodaniu recenzentów można wznowić go bezpośrednio
z kolejki `Invite Reviewers`:

```bash
npm run select-reviewers:resume -- --reviewers-per-paper=10 --slow-mo=500 --keep-open
```

`Invite`, `Selected` oraz `Agreed` bez `Overdue` liczą się do limitu. Każda osoba,
która już występuje w `Reviewer List`, jest zawsze wykluczona z ponownego Add —
również po `Declined`, `Auto-Declined`, `Unavailable`, `Overdue` lub `Reject`.

Tryb obsługuje paginację kandydatów i ponownie odczytuje DOM po każdym Add.
Log krok po kroku trafia do `logs/select-reviewers-*.jsonl`.

## Wybór i wysłanie zaproszeń

Ta komenda wykonuje także drugi `Invite All` w popupie i akceptuje natywny
dialog `confirm`. Nie trzeba wpisywać `confirm` ani ręcznie klikać `OK` — jawne
uruchomienie wariantu `:invite` jest jedynym potwierdzeniem. Jest to operacja
rzeczywista i nieodwracalna:

```bash
npm run select-reviewers:invite -- --reviewers-per-paper=10 --slow-mo=500 --keep-open
```

Jeśli recenzenci zostali już dodani i artykuł znajduje się w kolejce
`Invite Reviewers`, użyj wariantu wznawiającego i wysyłającego:

```bash
npm run select-reviewers:resume:invite -- --reviewers-per-paper=10 --slow-mo=500 --keep-open
```

Partia kilku artykulow jest dostepna w karcie `Reviewers` w UI albo przez
`--max-manuscripts`. Tryb partii wymaga `--invite-all`, poniewaz bez wysylki
pierwszy popup pozostaje otwarty:

```bash
npm run select-reviewers:invite -- --reviewers-per-paper=10 --max-manuscripts=5 --slow-mo=500
```

W UI domyslny tryb `Combined` tworzy jedna logiczna kolejke. Najpierw konczy
artykuly czekajace w `Invite Reviewers`, a potem pobiera nowe z `Select Reviewers`.
Jesli ScholarOne wyloguje automat przed wyslaniem, skrypt loguje sie ponownie i
szuka tego samego manuscript ID najpierw w `Invite Reviewers`, potem w
`Select Reviewers`. Nie wznawia automatycznie po rozpoczeciu wysylki, bo mogloby
to wyslac zaproszenia drugi raz.

Gdy dla artykulu zabraknie unikalnych kandydatow przed osiagnieciem celu, automat
klika jego `Refresh Search`, zapamietuje manuscript ID i odklada artykul. Najpierw
przetwarza pozostale artykuly z zaplanowanej partii, a potem co 60 sekund wraca do
odlozonych pozycji po dokladnym ID. Jesli odswiezanie nadal trwa albo artykul jest
chwilowo niewidoczny w obu kolejkach, czeka i probuje ponownie. Prace mozna
przerwac przyciskiem `Stop` w UI albo `Ctrl+C` w terminalu.

Ten sam tryb jest dostepny z terminala:

```bash
npm run select-reviewers:invite -- --reviewer-queue=combined --reviewers-per-paper=10 --max-manuscripts=5 --slow-mo=500
```

Po wysłaniu automat odświeża stronę artykułu i wymaga potwierdzenia w statusach
recenzentów albo we wzroście licznika `invited`. Samo zamknięcie popupu nie jest
uznawane za sukces. Liczbę różnych artykułów pobieranych w jednej partii określa
`--max-manuscripts`; odłożone artykuły wracają później w ramach tej samej partii.

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
- `--select-reviewers` - uruchamia osobny tryb wyboru recenzentów.
- `--reviewers-per-paper=10` - docelowa liczba kwalifikujących się recenzentów.
- `--refresh-wait-seconds=60` - przerwa pomiedzy powrotami do artykulow odlozonych po `Refresh Search`.
- `--invite-all` - jawnie zezwala na drugi, wysyłający przycisk `Invite All`.
- `--resume-invite-reviewers` - wznawia pierwszy artykuł z kolejki `Invite Reviewers` (np. po błędzie już po dodaniu recenzentów).
