# EIC assessment

Drugi etap oceny działa na kolejce `Awaiting EIC Assignment`. Ma własny prompt,
wyniki, cache i plik wznowienia. Nie zmienia konfiguracji `Initial assessment`.

## Bezpieczny przebieg

```bash
node bin/scholarone.js eic-screen --dry-run
```

Dry run czyta tytuły i abstrakty, uruchamia LLM i zapisuje wynik w
`logs/eic-assessment/`. Nie klika decyzji ani przypisań w ScholarOne.

Po sprawdzeniu tabeli w zakładce `EIC assessment` można wykonać dokładnie
zapisane decyzje, bez ponownego pytania modelu:

```bash
node bin/scholarone.js eic-screen \
  --from-run=logs/eic-assessment/RUN_ID.json
```

## Tryb live

```bash
node bin/scholarone.js eic-screen --live --max-checked=5
```

Każdy artykuł najpierw dostaje skonfigurowanego edytora jako EIC i AE.

| Decyzja LLM | Skutek |
|---|---|
| `APPROVE` | artykuł zatrzymuje się w `Assign Reviewers` |
| `REJECT` | wybiera `Reject - Fatally Flawed`, zapisuje mail i zatwierdza decyzję |

Ten workflow nie wybiera i nie zaprasza recenzentów. Robi to osobny workflow
`reviewers`.

## Konfiguracja

Prompt i wiadomość Reject można edytować w panelu. CLI przyjmuje także:

```bash
--assessment-prompt-file=prompt.txt
--screening-reject-message-file=reject.txt
--assessment-model=gpt-5.6-terra
--assessment-reasoning-effort=high
--max-live-actions=5
```

Dla drugiego etapu zmienne środowiskowe promptu to
`EIC_ASSESSMENT_PROMPT_FILE` lub `EIC_ASSESSMENT_PROMPT`. Wiadomość może użyć
`EIC_ASSESSMENT_REJECT_MESSAGE_FILE` lub `EIC_ASSESSMENT_REJECT_MESSAGE`.

Jeśli akcja została rozpoczęta, ale nie potwierdzona, wznowienie jej nie
powtórzy. Zatrzyma artykuł do ręcznego sprawdzenia.
