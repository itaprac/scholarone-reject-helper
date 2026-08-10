# Odrzucanie z kolejki Complete Checklist

## Dry-run

Niczego nie odrzuca. Sprawdza manuskrypty i zapisuje raport JSON/CSV w
`logs/reports/`.

```bash
node bin/scholarone.js reject --dry-run -- --max-checked=50 --submitted-older-than-days=30
```

## Odrzucanie

Od razu wykonuje reject dla pasujących manuskryptów.

```bash
node bin/scholarone.js reject --send --max-checked=50 --max-rejected=4 --slow-mo=800
```

`--max-rejected=4` to bezpiecznik. Bez niego jedynym limitem jest
`--max-checked`.

## Odrzucanie z raportu

Bezpieczniejsza ścieżka: najpierw obejrzyj, potem wykonaj.

1. odpal dry-run,
2. sprawdź raport w panelu albo w `logs/reports/`,
3. odpal reject z wybranego raportu.

```bash
node bin/scholarone.js reject --send --from-report=logs/reports/RUN_ID.json
```

Automat wyszukuje każde ID z raportu, **ponownie sprawdza reguły** i dopiero
wtedy odrzuca — raport nie jest ślepą listą do wykonania. Trwa to dłużej niż
zwykły przebieg.

Obok raportu powstaje `*.progress.json`, dzięki czemu ponowne uruchomienie
pomija manuskrypty już obsłużone.

## Treść wiadomości

Kolejność źródeł: flaga, plik, `.env`, wartość wbudowana.

```bash
--reject-message="Dear Author(s), ..."
--reject-message-file=reject-message.txt
```

W panelu treść edytuje się w sekcji `Settings` i zapisuje do
`ui-settings.json`.

## Co trafia do raportu

- `checked` — ile manuskryptów sprawdzono,
- `candidates` — ile spełniło reguły odrzucenia,
- dla każdego: ID, tytuł, data zgłoszenia, powód decyzji i wykonana akcja.

CSV obok raportu ma te same dane w formie do otwarcia w arkuszu.
