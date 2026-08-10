// Nazwane progi czasowe. Wcześniej te same liczby były rozsypane po obu
// monolitach w dwóch zapisach naraz (15000 i 15_000), więc nie dało się
// stwierdzić, które z nich znaczą to samo.
export const TIMEOUTS = Object.freeze({
  // Domyślny limit akcji Playwrighta dla całej strony.
  default: 15_000,

  // Sprawdzenie, czy element już jest — ma zawieść szybko, bo zwykle jest to
  // tylko rozpoznanie wariantu strony.
  probe: 1_500,
  shortProbe: 1_000,

  // Kliknięcie w kontrolkę, o której wiemy, że istnieje.
  click: 3_000,

  // Czekanie na pojawienie się elementu po akcji.
  element: 5_000,
  slowElement: 10_000,

  // Nawigacja ScholarOne. Serwer bywa wolny, a część przejść to POST formularza.
  navigation: 12_000,
  slowNavigation: 20_000,

  // Logowanie: obejmuje przekierowania SSO i ewentualny ekran 2FA.
  login: 20_000,
  loginRedirect: 30_000,

  // Odnalezienie artykułu po ID w kolejce po ponownym zalogowaniu.
  manuscriptIdentity: 45_000,

  // Krótka pauza po akcji, która nie daje żadnego sygnału zwrotnego.
  settle: 300,
  menuSettle: 800,
});
