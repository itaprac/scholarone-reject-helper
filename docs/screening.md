# Wstępna ocena artykułów przez LLM

Tryb korzysta z kolejki `Manage → Admin Center → Complete Checklist`.

## Jak decyduje

- Manuskrypty `.R` + liczba dostają `APPROVE` automatycznie, bez otwierania
  abstraktu i bez wywołania modelu — także przy czerwonym alercie.
- Pozostałe z komunikatem `High rate of unusual activity` są pomijane.
- Dla reszty helper zapisuje tytuł, otwiera popup `Abstract`, kopiuje treść i
  wysyła komplet danych do modelu.

Model zwraca `APPROVE` albo `REJECT` w ścisłym JSON, zgodnym ze schematem
`src/assessment-output.schema.json`.

## Dry-run

Zapisuje decyzje bez jakiejkolwiek akcji w ScholarOne.

```bash
node bin/scholarone.js screen --dry-run
```

W tym trybie ocena **nie blokuje** przeglądarki: automat zbiera metadane
kolejnych artykułów, a oceny domykają się równolegle (domyślnie 3 naraz,
`--assessment-concurrency=N`). Czas przebiegu spada do wolniejszego z etapów
zamiast ich sumy.

## Obejrzyj, potem wykonaj

Bezpieczniejsza ścieżka, ta sama co przy odrzucaniu z raportu:

1. odpal `screen --dry-run`,
2. obejrzyj decyzje w panelu, w karcie `Initial assessment`,
3. kliknij **Execute these decisions** albo z terminala:

```bash
node bin/scholarone.js screen --from-run=logs/screening/RUN_ID.json
```

Ten tryb **nie pyta modelu ponownie**. Bierze decyzje z pliku, wyszukuje każdy
manuskrypt po ID i wykonuje dokładnie to, co zatwierdziłeś. Pomijane są:

- artykuły, którym ten przebieg już wykonał akcję (inaczej poszedłby drugi mail),
- artykuły z nieudaną oceną,
- artykuły, których nie ma już w kolejce — najczęściej dlatego, że ktoś obsłużył
  je ręcznie.

W panelu przycisk jest nieaktywny, gdy w wybranym przebiegu nie ma nic do
zrobienia, więc nie da się wykonać tego samego dwa razy.

## Ocena i wykonanie w jednym przebiegu

```bash
node bin/scholarone.js screen --live --max-checked=10
```

Dla `REJECT` wysyła wiadomość z `--screening-reject-message`, dla `APPROVE`
zaznacza oba pola Admin Checklist, zatwierdza pracę i przypisuje edytora
kolejno jako Editor-in-Chief oraz Associate Editor.

### Approve bez dobierania edytorów

```bash
node bin/scholarone.js screen --live --approve-without-assign
node bin/scholarone.js screen --from-run=logs/screening/RUN_ID.json --approve-without-assign
```

Z flagą `--approve-without-assign` (w panelu: „Approve without assigning
editors") `APPROVE` kończy się na kliknięciu **Approve** — artykuł zostaje w
kolejce `Awaiting EIC Assignment`, a edytorów dobiera człowiek po przejrzeniu
PDF-a. W ten sposób LLM robi pierwszą ocenę, a ostateczne potwierdzenie
(dobranie EIC i AE) należy do redaktora.

- `REJECT` działa bez zmian — wiadomość odrzucająca jest wysyłana.
- Rewizje (`.R` + liczba) nadal przechodzą pełną ścieżkę z dobraniem edytorów.
- W action-logu taka akcja ma nazwę `approve-awaiting-assignment`, a
  podsumowanie przebiegu raportuje licznik `liveApprovedAwaitingAssignment`.

Tryb live zatrzymuje kolejkę na pierwszym kroku, którego nie da się
jednoznacznie potwierdzić. Ocena jest wtedy sekwencyjna — decyzja musi być
znana, zanim automat kliknie cokolwiek na otwartej stronie.

### Wznawianie

Stan każdego manuskryptu trafia do `logs/screening/live.progress.json`
**przed** akcją i jest domykany po potwierdzeniu:

- `approved` / `rejected` / `skipped` — przy wznowieniu pomijane,
- `attempted` — akcja się zaczęła i nie została potwierdzona. Wznowienie
  zatrzymuje się i wskazuje artykuł do ręcznego sprawdzenia, zamiast wysłać
  wiadomość drugi raz.

### Bezpiecznik

`--max-live-actions` (domyślnie 25) ogranicza liczbę operacji nieodwracalnych w
przebiegu. Limit jest sprawdzany przed akcją — przekroczenie zatrzymuje
przebieg, zamiast wykonać operację o jedną za dużo.

## Cache ocen

Wynik jest zapisywany w `logs/assessment-cache/` pod kluczem liczonym z treści
artykułu, promptu, modelu i poziomu reasoningu. Powtórny przebieg po tej samej
kolejce nie płaci drugi raz — przy dobieraniu promptu to główny koszt.

Zmiana promptu, modelu albo poziomu reasoningu automatycznie unieważnia wpis.
Wymuszenie świeżej oceny: `--no-cache`.

Trafienie w cache raportuje zerowe zużycie tokenów, żeby podsumowanie przebiegu
nie doliczało ich ponownie.

## Prompt

Domyślny prompt stosuje regułę `Probability of REJECT > 65% → REJECT` —
odrzuca tylko przy wyraźnej pewności modelu, bo APPROVE i tak przechodzi przez
człowieka (zwłaszcza z `--approve-without-assign`), a REJECT wysyła
nieodwracalny mail. Można go
edytować w panelu w karcie `Initial assessment` albo podać przez
`--assessment-prompt-file=...`.

Dane artykułu są wysyłane w sekcji oznaczonej jako niezaufana, z instrukcją
ignorowania poleceń z jej wnętrza.

## Wyniki

Wszystko trafia do jednego pliku JSON w `logs/screening/`. Obok powstaje
czytelny `*-summary.csv` z tytułem, abstraktem, decyzją, uzasadnieniem,
ewentualną akcją lub błędem, czasem oceny i zużyciem tokenów.

W terminalu po każdej ocenie pojawia się `[LLM USAGE]`, a na końcu
`[TOKEN SUMMARY]`. Licznik `input` obejmuje już tokeny z cache, a `output`
obejmuje reasoning — dlatego `razem` to `input + output`, bez ponownego
dodawania tych pól.

## Wymagania

Tryb wymaga Codex CLI zalogowanego przez `codex login`. Stan sprawdzisz przez
`npm run doctor`. Pozostałe tryby działają bez niego.
