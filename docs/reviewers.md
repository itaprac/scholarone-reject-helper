# Wybór i zapraszanie recenzentów

## Tryb bezpieczny

Otwiera pierwszy artykuł z kolejki `Select Reviewers`, odczytuje całą
`Reviewer List`, dodaje brakujących unikalnych kandydatów do limitu, otwiera
pierwszy popup `Invite All` i **zatrzymuje się przed drugim przyciskiem**, który
naprawdę wysyła zaproszenia.

```bash
node bin/scholarone.js reviewers --prepare --reviewers-per-paper=10 --keep-open
```

Tryb przygotowania obsługuje jeden manuskrypt na uruchomienie — pierwszy popup
zostaje otwarty, więc nie ma jak przejść do kolejnego artykułu.

## Wysyłka zaproszeń

Wykonuje także drugi `Invite All` i akceptuje natywny dialog `confirm`. Jawne
uruchomienie wariantu `--invite` jest jedynym potwierdzeniem. Operacja jest
nieodwracalna.

```bash
node bin/scholarone.js reviewers --invite --reviewers-per-paper=10
```

Po wysłaniu automat odświeża stronę artykułu i czeka na potwierdzenie w statusach
recenzentów albo we wzroście licznika `invited`. Sprawdza ponownie opóźnione
aktualizacje strony, bez ponownego kliknięcia wysyłki. Wzrost licznika może
potwierdzić wysyłkę tylko wtedy, gdy udało się odczytać jego wartość przed
wysłaniem. **Samo zamknięcie popupu nie jest uznawane za sukces.**

## Kto liczy się do limitu

`Invite`, `Selected` oraz `Agreed` bez `Overdue` liczą się do celu. Każda osoba,
która już występuje w `Reviewer List`, jest zawsze wykluczona z ponownego Add —
również po `Declined`, `Auto-Declined`, `Unavailable`, `Overdue` lub `Reject`.

## Partia artykułów

```bash
node bin/scholarone.js reviewers --invite --queue=combined --max-manuscripts=5
```

Tryb `combined` tworzy jedną logiczną kolejkę: najpierw kończy artykuły
czekające w `Invite Reviewers`, potem pobiera nowe z `Select Reviewers`.

Jeśli ScholarOne wyloguje automat przed wysłaniem, skrypt loguje się ponownie i
szuka tego samego manuscript ID najpierw w `Invite Reviewers`, potem w
`Select Reviewers`. **Nie wznawia automatycznie po rozpoczęciu wysyłki** — mogłoby
to wysłać zaproszenia drugi raz.

## Brak kandydatów

Gdy dla artykułu zabraknie unikalnych kandydatów przed osiągnięciem celu,
automat klika `Refresh Search`, zapamiętuje manuscript ID i odkłada artykuł.
Najpierw przetwarza pozostałe pozycje z partii, a potem wraca do odłożonych
po dokładnym ID, z uwzględnieniem rewizji. Czas `--refresh-wait-seconds`
(domyślnie 60) liczy od odłożenia artykułu. Jeśli ten czas upłynął podczas
obsługi innych artykułów, nie czeka ponownie pełnej minuty.

Jeśli odświeżanie nadal trwa albo artykuł jest chwilowo niewidoczny w obu
kolejkach, czeka i próbuje ponownie. Pracę można przerwać przyciskiem `Stop` w
panelu albo `Ctrl+C` w terminalu.

## Wznawianie

Po przerwaniu przebiegu już po dodaniu recenzentów:

```bash
node bin/scholarone.js reviewers --prepare --resume-invite-reviewers
node bin/scholarone.js reviewers --invite --resume-invite-reviewers
```

## Popup Create Account

Kandydat spoza bazy wymaga utworzenia konta. Automat obsługuje też przypadek,
w którym ScholarOne pokazuje podobne konta — jeśli żadne nie pasuje dokładnie
adresem e-mail, kandydat jest pomijany, a nie dodawany na oślep.

Log krok po kroku trafia do `logs/select-reviewers-*.jsonl`.

## Czas odczytu listy

Workflow nadal sprawdza wszystkie strony `Reviewer List`. Zaczyna od strony
już otwartej i pomija powrót do początkowego widoku, gdy nie jest on potrzebny
do następnego kroku. Przy liście dwustronicowej zmniejsza to liczbę żądań
potrzebnych do kolejnych pełnych odczytów z dwóch do jednego na odczyt.

Pusta kolejka na początku oznacza poprawne zakończenie z zerową liczbą
obsłużonych artykułów. Dla wyboru recenzentów automat sprawdza obie nazwy
kolejki: `Assign Reviewers` oraz `Select Reviewers`.
