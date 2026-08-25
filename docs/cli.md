<!-- Plik generowany. Nie edytuj ręcznie:
     node scripts/generate-cli-docs.js -->

# Referencja komend i flag

```
scholarone reject     --dry-run | --send [--from-report=PLIK]
scholarone screen     --dry-run | --live
scholarone eic-screen --dry-run | --live [--from-run=PLIK]
scholarone reviewers  --prepare | --invite [--queue=combined|select|invite]
scholarone doctor
scholarone ui
```

Domyślny wariant każdej komendy jest bezpieczny. Operacja nieodwracalna
wymaga jawnego `--send`, `--live` albo `--invite`.

## Opcje według trybu

### reject --dry-run

| Flaga | Typ | Domyślnie | Opis |
|---|---|---|---|
| `--start-url` | url | https://mc.manuscriptcentral.com/kes | Adres startowy ScholarOne. |
| `--max-checked` | int ≥ 1 | 200 | Ile manuskryptów sprawdzić w tym przebiegu. |
| `--submitted-older-than-days` | int ≥ 1 | 30 | Próg wieku zgłoszenia. |
| `--queue-start-page` | int ≥ 1 | — | Start od danej strony listy, np. 2 to pozycje 11-20. |
| `--slow-mo` | int ≥ 0 | 500 | Spowolnienie kliknięć Playwrighta. |
| `--keep-open` | bool | false | Keep browser open |

### reject --send

| Flaga | Typ | Domyślnie | Opis |
|---|---|---|---|
| `--start-url` | url | https://mc.manuscriptcentral.com/kes | Adres startowy ScholarOne. |
| `--max-checked` | int ≥ 1 | 200 | Ile manuskryptów sprawdzić w tym przebiegu. |
| `--submitted-older-than-days` | int ≥ 1 | 30 | Próg wieku zgłoszenia. |
| `--queue-start-page` | int ≥ 1 | — | Start od danej strony listy, np. 2 to pozycje 11-20. |
| `--max-rejected` | int ≥ 1 | — | Bezpiecznik: maksymalna liczba odrzuceń w przebiegu. |
| `--slow-mo` | int ≥ 0 | 500 | Spowolnienie kliknięć Playwrighta. |
| `--reject-message` | text | — | Rejection email |
| `--keep-open` | bool | false | Keep browser open |

### reject --send --from-report=...

| Flaga | Typ | Domyślnie | Opis |
|---|---|---|---|
| `--start-url` | url | https://mc.manuscriptcentral.com/kes | Adres startowy ScholarOne. |
| `--submitted-older-than-days` | int ≥ 1 | 30 | Próg wieku zgłoszenia. |
| `--max-rejected` | int ≥ 1 | — | Bezpiecznik: maksymalna liczba odrzuceń w przebiegu. |
| `--slow-mo` | int ≥ 0 | 500 | Spowolnienie kliknięć Playwrighta. |
| `--reject-message` | text | — | Rejection email |
| `--keep-open` | bool | false | Keep browser open |

### reviewers --prepare

| Flaga | Typ | Domyślnie | Opis |
|---|---|---|---|
| `--start-url` | url | https://mc.manuscriptcentral.com/kes | Start URL |
| `--reviewers-per-paper` | int ≥ 1 | 10 | Reviewers per paper |
| `--max-manuscripts` | int ≥ 1 | 10 | Max manuscripts |
| `--slow-mo` | int ≥ 0 | 500 | Slow motion (ms) |
| `--refresh-wait-seconds` | int ≥ 1 | 60 | Przerwa przed powrotem do artykułu odłożonego po Refresh Search. |
| `--keep-open` | bool | false | Keep browser open |

### reviewers --invite

| Flaga | Typ | Domyślnie | Opis |
|---|---|---|---|
| `--start-url` | url | https://mc.manuscriptcentral.com/kes | Start URL |
| `--reviewers-per-paper` | int ≥ 1 | 10 | Reviewers per paper |
| `--max-manuscripts` | int ≥ 1 | 10 | Max manuscripts |
| `--slow-mo` | int ≥ 0 | 500 | Slow motion (ms) |
| `--refresh-wait-seconds` | int ≥ 1 | 60 | Przerwa przed powrotem do artykułu odłożonego po Refresh Search. |
| `--keep-open` | bool | false | Keep browser open |

### screen

| Flaga | Typ | Domyślnie | Opis |
|---|---|---|---|
| `--start-url` | url | https://mc.manuscriptcentral.com/kes | Start URL |
| `--max-checked` | int ≥ 1 | 100 | Max checked |
| `--slow-mo` | int ≥ 0 | 500 | Slow motion (ms) |
| `--assessment-model` | text | gpt-5.6-terra | Model |
| `--assessment-reasoning-effort` | low \| medium \| high | medium | Reasoning effort |
| `--assessment-timeout-seconds` | int ≥ 10 | 120 | Timeout (s) |
| `--assessment-prompt` | text | — | Assessment prompt |
| `--keep-open` | bool | false | Keep browser open |

### eic-screen

| Flaga | Typ | Domyślnie | Opis |
|---|---|---|---|
| `--start-url` | url | https://mc.manuscriptcentral.com/kes | Start URL |
| `--max-checked` | int ≥ 1 | 100 | Max checked |
| `--slow-mo` | int ≥ 0 | 500 | Slow motion (ms) |
| `--assessment-model` | text | gpt-5.6-terra | Model |
| `--assessment-reasoning-effort` | low \| medium \| high | medium | Reasoning effort |
| `--assessment-timeout-seconds` | int ≥ 10 | 120 | Timeout (s) |
| `--assessment-prompt` | text | — | Second assessment prompt |
| `--keep-open` | bool | false | Keep browser open |

## Opcje wspólne

| Flaga | Opis |
|---|---|
| `--headed` | okno przeglądarki widoczne (domyślne dla komend) |
| `--headless` | bez okna |
| `--keep-open` | zostaw przeglądarkę otwartą po zakończeniu |
| `--debug-screenshots` | zapisuj zrzut z każdego kroku, nie tylko przy błędach |
| `--profile-dir=` | katalog profilu Chromium |
| `--logs-dir=` | katalog logów |
| `--cdp=` | podłącz się do działającego Chrome zamiast własnego profilu |
| `--browser-channel=` | kanał przeglądarki, np. `chrome` |

## Bezpieczniki

| Flaga | Opis |
|---|---|
| `--max-rejected=N` | limit odrzuceń w przebiegu |
| `--max-live-actions=N` | limit operacji nieodwracalnych w assessment live (domyślnie 25) |
| `--require-targets` | przebieg musi dostać listę celów, inaczej przerywa |

## Ocena LLM

| Flaga | Opis |
|---|---|
| `--assessment-concurrency=N` | ile ocen naraz w dry-runie (domyślnie 3) |
| `--no-cache` | wymuś świeżą ocenę, pomijając cache |
| `--assessment-prompt-file=` | prompt z pliku |
| `--screening-reject-message-file=` | treść wiadomości odrzucenia z pliku |
| `--assessment-stage=eic` | użyj Awaiting EIC Assignment i drugiego promptu |

Każda flaga ma odpowiednik w `.env` — kolejność źródeł to: flaga CLI,
zmienna środowiskowa, wartość domyślna.
