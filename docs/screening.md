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

## Wykonanie decyzji

```bash
node bin/scholarone.js screen --live --max-checked=10
```

Dla `REJECT` wysyła wiadomość z `--screening-reject-message`, dla `APPROVE`
zaznacza oba pola Admin Checklist, zatwierdza pracę i przypisuje edytora
kolejno jako Editor-in-Chief oraz Associate Editor.

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

Domyślny prompt stosuje regułę `Probability of REJECT > 40% → REJECT`. Można go
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
