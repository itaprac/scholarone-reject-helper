import assert from "node:assert/strict";
import test from "node:test";
import { tailSince } from "../src/job-tail.js";

// Panel dokleja przyrost zamiast przerysowywać cały log. Gdyby ta arytmetyka
// była błędna, użytkownik zobaczyłby zdublowane albo pogubione linie — i nie
// miałby jak tego zauważyć.

test("bez podanego offsetu oddaje cały bufor", () => {
  assert.equal(tailSince("abcdef", 6, Number.NaN), "abcdef");
  assert.equal(tailSince("abcdef", 6, -1), "abcdef");
});

test("klient na bieżąco nie dostaje niczego", () => {
  assert.equal(tailSince("abcdef", 6, 6), "");
});

test("oddaje dokładnie brakujący ogon", () => {
  assert.equal(tailSince("abcdef", 6, 4), "ef");
  assert.equal(tailSince("abcdef", 6, 0), "abcdef");
});

test("klient wyprzedzający serwer nie dostaje śmieci", () => {
  // Zdarza się po restarcie panelu, gdy licznik zaczyna od zera.
  assert.equal(tailSince("abc", 3, 10), "");
});

test("po przycięciu bufora oddaje wszystko, co zostało", () => {
  // Przebieg wyprodukował 1000 znaków, ale bufor trzyma ostatnie 10.
  const output = "0123456789";
  assert.equal(tailSince(output, 1000, 0), output);
  assert.equal(tailSince(output, 1000, 500), output);
});

test("liczy w znakach, nie w bajtach", () => {
  // Log automatu jest po polsku; przy liczeniu bajtów ogon urwałby się w złym
  // miejscu i w panelu pojawiłyby się powtórzone fragmenty linii.
  const output = "zażółć gęślą jaźń";
  const produced = output.length;

  assert.equal(tailSince(output, produced, produced - 4), "jaźń");
  assert.equal(tailSince(output, produced, 0), output);
});

test("przyrostowe doklejanie odtwarza pełny log", () => {
  const chunks = ["[1] KES-25-0001 -> tytuł: Ą\n", "[LLM RESULT] REJECT: powód\n", "koniec\n"];

  let buffer = "";
  let produced = 0;
  let clientOffset = 0;
  let clientView = "";

  for (const chunk of chunks) {
    buffer += chunk;
    produced += chunk.length;
    clientView += tailSince(buffer, produced, clientOffset);
    clientOffset = produced;
  }

  assert.equal(clientView, chunks.join(""));
});
