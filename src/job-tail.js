// Wycinanie przyrostu logu od znanego klientowi offsetu.
//
// Panel odpytywał wcześniej o cały bufor przy każdym odświeżeniu — do 120 KB co
// 1,5 s, plus przerysowanie całego elementu od zera. Klient pamięta, ile już
// dostał, i prosi wyłącznie o resztę.
//
// Bufor jest przycinany do ostatnich N znaków, więc offset przebiegu rośnie
// dalej niż długość bufora. Różnica między nimi mówi, ile znaków bezpowrotnie
// wypadło z początku.
export function tailSince(output, offset, since) {
  if (!Number.isFinite(since) || since < 0) return output;

  const produced = Number(offset) || 0;
  const missing = produced - since;

  // Klient jest na bieżąco albo wyprzedza serwer (np. po restarcie joba).
  if (missing <= 0) return "";

  // Klient został tak daleko w tyle, że brakujący fragment już wypadł z bufora
  // — oddajemy wszystko, co zostało.
  if (missing >= output.length) return output;

  return output.slice(output.length - missing);
}
