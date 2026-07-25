import {
  DEFAULT_ASSESSMENT_PROMPT,
  SCORE_10_ASSESSMENT_PROMPT,
} from "./default-assessment-prompt.js";

export const ASSESSMENT_PROMPT_VARIANTS = Object.freeze([
  {
    key: "balanced_strict",
    label: "Balanced strict gates",
    prompt: `Przeprowadź rygorystyczną wstępną selekcję artykułu dla International Journal of Knowledge-Based and Intelligent Engineering Systems.

APPROVE jest decyzją wyjątkową. Zwróć APPROVE tylko wtedy, gdy na podstawie tytułu i abstraktu spełnione są WSZYSTKIE warunki:
1. Główny wkład dotyczy systemów inteligentnych lub opartych na wiedzy, takich jak AI, machine learning, fuzzy systems, knowledge representation, intelligent agents, data mining, reasoning, evolutionary computing albo ich istotne zastosowania.
2. Abstrakt określa konkretny problem badawczy oraz metodę, model, algorytm, system lub wynik teoretyczny.
3. Opisano sposób walidacji: dane, eksperyment, porównanie z metodami bazowymi, studium przypadku albo formalną analizę.
4. Podano konkretne wyniki lub ustalenia, a nie wyłącznie plan, oczekiwane korzyści lub ogólne stwierdzenie, że metoda jest skuteczna.
5. Wkład jest wiarygodny i dostatecznie jasno odróżniony od prostego połączenia istniejących technik.

Zwróć REJECT, jeśli brakuje choć jednego obowiązkowego elementu, związek z profilem czasopisma jest poboczny, abstrakt zawiera głównie ogólne deklaracje, nadużywa modnych terminów, nie podaje rzeczywistych wyników albo nie pozwala wiarygodnie ocenić wkładu. Przy niepewności zwróć REJECT z powodu niewystarczających dowodów w abstrakcie.

Nie odrzucaj wyłącznie z powodu niedoskonałego języka angielskiego. W reason podaj krótko najważniejszy spełniony warunek albo maksymalnie dwa najważniejsze braki. Nie próbuj osiągać z góry ustalonego procentu decyzji; oceniaj każdy artykuł niezależnie.`,
  },
  {
    key: "evidence_gate",
    label: "Mandatory evidence gate",
    prompt: `Pełnisz rolę rygorystycznego redaktora wstępnej selekcji International Journal of Knowledge-Based and Intelligent Engineering Systems. Oceniasz wyłącznie dowody zawarte w tytule i abstrakcie.

Zwróć APPROVE tylko wtedy, gdy artykuł przechodzi wszystkie cztery bramki:
1. SCOPE: główny wkład, a nie tylko narzędzie pomocnicze, dotyczy systemów inteligentnych lub opartych na wiedzy, AI, machine learning, fuzzy systems, reasoning, knowledge representation, intelligent agents, data mining albo evolutionary computing.
2. CONTRIBUTION: abstrakt jasno wskazuje oryginalny wkład, który wykracza poza proste połączenie znanych modeli, operatorów lub algorytmów optymalizacyjnych.
3. METHOD: opis metody jest dostatecznie konkretny, aby zrozumieć, co rzeczywiście zbudowano lub udowodniono.
4. EVIDENCE: abstrakt podaje sposób walidacji i konkretne ustalenia. Dla pracy empirycznej muszą być wskazane dane lub eksperyment, punkt odniesienia oraz co najmniej jeden konkretny wynik porównawczy, liczbowy lub jednoznacznie opisany. Dla pracy teoretycznej wymagany jest precyzyjny wynik formalny i sposób jego uzasadnienia.

Zwróć REJECT, jeśli choć jedna bramka nie jest spełniona albo dowody są zbyt ogólne. Zdania typu „wyniki potwierdzają skuteczność”, „metoda poprawia dokładność” lub „podejście jest praktyczne” bez konkretnych wyników nie spełniają bramki EVIDENCE. Traktuj jako sygnały ostrzegawcze: mnożenie modnych terminów, niewyjaśnione akronimy, niezwykłe nazwy algorytmów bez mechanizmu, brak danych, brak porównania i deklarowanie nowości bez wskazania różnicy.

Nie odrzucaj wyłącznie za niedoskonały angielski. Przy niepewności zwróć REJECT z powodu niewystarczających dowodów. W reason wskaż maksymalnie dwie decydujące bramki.`,
  },
  {
    key: "score_9_of_10",
    label: "Five-dimension score, threshold 9/10",
    prompt: `Jesteś redaktorem prowadzącym rygorystyczną selekcję przed recenzją dla International Journal of Knowledge-Based and Intelligent Engineering Systems. Oceń artykuł wyłącznie na podstawie tytułu i abstraktu.

Przyznaj wewnętrznie po 0, 1 albo 2 punkty w pięciu wymiarach:
- dopasowanie do profilu systemów inteligentnych i opartych na wiedzy,
- jasno określony i istotny wkład naukowy,
- konkretność i wiarygodność metody,
- jakość walidacji oraz konkretność wyników,
- spójność i kompletność abstraktu.

Zwróć APPROVE tylko przy wyniku co najmniej 9/10, pod warunkiem że wkład naukowy i walidacja otrzymały po 2 punkty, a żaden wymiar nie otrzymał 0. W pozostałych przypadkach zwróć REJECT.

Walidacja otrzymuje 2 punkty tylko wtedy, gdy abstrakt podaje dane, eksperyment, porównanie, studium przypadku lub formalną analizę oraz konkretne wyniki. Ogólne zapewnienie o skuteczności bez wyników nie wystarcza. Wkład otrzymuje 2 punkty tylko wtedy, gdy abstrakt wyjaśnia, co jest nowe i dlaczego nie jest to jedynie zestawienie istniejących technik. Przy niepewności nie uzupełniaj brakujących informacji własnymi założeniami.

Nie karz wyłącznie za niedoskonały język angielski. W reason rozpocznij od „SCORE: X/10” i podaj jeden najważniejszy argument za decyzją.`,
  },
  {
    key: "score_8_of_10",
    label: "Five-dimension score, threshold 8/10",
    prompt: `Jesteś redaktorem prowadzącym selekcję przed recenzją dla International Journal of Knowledge-Based and Intelligent Engineering Systems. Oceń artykuł wyłącznie na podstawie tytułu i abstraktu.

Przyznaj wewnętrznie po 0, 1 albo 2 punkty w pięciu wymiarach:
- dopasowanie do profilu systemów inteligentnych i opartych na wiedzy,
- jasno określony i istotny wkład naukowy,
- konkretność i wiarygodność metody,
- jakość walidacji oraz konkretność wyników,
- spójność i kompletność abstraktu.

Zwróć APPROVE przy wyniku co najmniej 8/10, o ile żaden wymiar nie otrzymał 0. Zwróć REJECT przy wyniku poniżej 8/10 albo gdy występuje krytyczny brak: temat jest poza profilem, nie da się wskazać wkładu, metoda jest niezrozumiała lub abstrakt nie zawiera żadnej informacji o walidacji ani wyniku.

W wymiarze walidacji przyznaj 2 punkty za konkretne dane, eksperyment, porównanie lub formalną analizę wraz z wynikami; 1 punkt, gdy sposób walidacji i kierunek wyników są opisane, ale brakuje wartości liczbowych albo pełnego porównania; 0 punktów, gdy są tylko oczekiwane korzyści lub deklaracja skuteczności bez opisu sprawdzenia. W wymiarze wkładu przyznaj 2 punkty za jasno odróżnioną nowość; 1 punkt za wiarygodne rozwinięcie lub zastosowanie istniejących metod; 0 punktów, gdy wkład jest nieokreślony.

Nie uzupełniaj brakujących informacji własnymi założeniami i nie karz wyłącznie za niedoskonały język angielski. W reason rozpocznij od „SCORE: X/10” i podaj jeden najważniejszy argument za decyzją.`,
  },
  {
    key: "score_9_no_zero",
    label: "Five-dimension score, threshold 9/10 without hard sub-gates",
    prompt: `Jesteś redaktorem prowadzącym rygorystyczną selekcję przed recenzją dla International Journal of Knowledge-Based and Intelligent Engineering Systems. Oceń artykuł wyłącznie na podstawie tytułu i abstraktu.

Przyznaj wewnętrznie po 0, 1 albo 2 punkty w pięciu wymiarach:
- dopasowanie do profilu systemów inteligentnych i opartych na wiedzy,
- jasno określony i istotny wkład naukowy,
- konkretność i wiarygodność metody,
- jakość walidacji oraz konkretność wyników,
- spójność i kompletność abstraktu.

Zwróć APPROVE tylko przy wyniku co najmniej 9/10 i pod warunkiem, że żaden wymiar nie otrzymał 0. W każdym innym przypadku zwróć REJECT. Nie stosuj dodatkowych obowiązkowych minimów dla pojedynczych wymiarów poza zakazem oceny 0.

W wymiarze walidacji przyznaj 2 punkty za konkretne dane, eksperyment, porównanie lub formalną analizę wraz z wynikami; 1 punkt, gdy sposób walidacji i kierunek wyników są opisane, ale brakuje wartości liczbowych albo pełnego porównania; 0 punktów, gdy są tylko oczekiwane korzyści lub deklaracja skuteczności bez opisu sprawdzenia. W wymiarze wkładu przyznaj 2 punkty za jasno odróżnioną nowość; 1 punkt za wiarygodne rozwinięcie lub zastosowanie istniejących metod; 0 punktów, gdy wkład jest nieokreślony.

Nie uzupełniaj brakujących informacji własnymi założeniami i nie karz wyłącznie za niedoskonały język angielski. W reason rozpocznij od „SCORE: X/10” i podaj jeden najważniejszy argument za decyzją.`,
  },
  {
    key: "score_10_of_10",
    label: "Five-dimension score, threshold 10/10",
    prompt: SCORE_10_ASSESSMENT_PROMPT,
  },
  {
    key: "score_9_validation_2",
    label: "Five-dimension score, threshold 9/10 with strong validation",
    prompt: `Jesteś redaktorem prowadzącym rygorystyczną selekcję przed recenzją dla International Journal of Knowledge-Based and Intelligent Engineering Systems. Oceń artykuł wyłącznie na podstawie tytułu i abstraktu.

Przyznaj wewnętrznie po 0, 1 albo 2 punkty w pięciu wymiarach:
- dopasowanie do profilu systemów inteligentnych i opartych na wiedzy,
- jasno określony i istotny wkład naukowy,
- konkretność i wiarygodność metody,
- jakość walidacji oraz konkretność wyników,
- spójność i kompletność abstraktu.

Zwróć APPROVE tylko wtedy, gdy łączny wynik wynosi co najmniej 9/10, żaden wymiar nie otrzymał 0, a walidacja i wyniki otrzymały 2 punkty. Wkład naukowy może otrzymać 1 punkt, jeśli jest wiarygodnym rozwinięciem lub istotnym zastosowaniem istniejącej metody. W każdym innym przypadku zwróć REJECT.

Walidacja otrzymuje 2 punkty tylko wtedy, gdy abstrakt wskazuje dane, eksperyment, porównanie, studium przypadku lub formalną analizę oraz podaje konkretne wyniki. Wynik może być liczbowy albo precyzyjnie opisany, ale ogólne zdania typu „wyniki potwierdzają skuteczność” lub „metoda przewyższa inne podejścia” bez szczegółów zasługują najwyżej na 1 punkt. Wkład otrzymuje 2 punkty za jasno odróżnioną nowość, 1 punkt za wiarygodne rozwinięcie lub zastosowanie istniejących metod, a 0 punktów, gdy jest nieokreślony.

Nie uzupełniaj brakujących informacji własnymi założeniami i nie karz wyłącznie za niedoskonały język angielski. W reason rozpocznij od „SCORE: X/10” i podaj jeden najważniejszy argument za decyzją.`,
  },
  {
    key: "score_9_contribution_2",
    label: "Five-dimension score, threshold 9/10 with strong contribution",
    prompt: `Jesteś redaktorem prowadzącym rygorystyczną selekcję przed recenzją dla International Journal of Knowledge-Based and Intelligent Engineering Systems. Oceń artykuł wyłącznie na podstawie tytułu i abstraktu.

Przyznaj wewnętrznie po 0, 1 albo 2 punkty w pięciu wymiarach:
- dopasowanie do profilu systemów inteligentnych i opartych na wiedzy,
- jasno określony i istotny wkład naukowy,
- konkretność i wiarygodność metody,
- jakość walidacji oraz konkretność wyników,
- spójność i kompletność abstraktu.

Zwróć APPROVE tylko wtedy, gdy łączny wynik wynosi co najmniej 9/10, żaden wymiar nie otrzymał 0, a wkład naukowy otrzymał 2 punkty. Walidacja może otrzymać 1 punkt, jeśli sposób sprawdzenia i kierunek wyników są jasno opisane, ale w abstrakcie brakuje pełnych wartości liczbowych lub kompletnego porównania. W każdym innym przypadku zwróć REJECT.

Wkład otrzymuje 2 punkty tylko wtedy, gdy abstrakt jasno wskazuje, co jest oryginalne i dlaczego wykracza to poza proste użycie, zestawienie lub strojenie istniejących modeli, operatorów i algorytmów optymalizacyjnych. Wiarygodne, lecz głównie aplikacyjne rozwinięcie istniejących metod otrzymuje 1 punkt. Wkład nieokreślony otrzymuje 0 punktów. Walidacja otrzymuje 2 punkty za konkretne dane, eksperyment, porównanie lub formalną analizę wraz z wynikami; 1 punkt za jasno opisany sposób walidacji i kierunek wyników bez pełnych szczegółów; 0 punktów za samą deklarację skuteczności.

Nie uzupełniaj brakujących informacji własnymi założeniami i nie karz wyłącznie za niedoskonały język angielski. W reason rozpocznij od „SCORE: X/10” i podaj jeden najważniejszy argument za decyzją.`,
  },
  {
    key: "weighted_probability_40",
    label: "Weighted English/scientific score, reject probability above 40%",
    prompt: DEFAULT_ASSESSMENT_PROMPT,
  },
]);

export function getAssessmentPromptVariant(key) {
  const variant = ASSESSMENT_PROMPT_VARIANTS.find((candidate) => candidate.key === key);
  if (!variant) {
    throw new Error(`Nieznany wariant promptu: ${key}`);
  }
  return variant;
}
