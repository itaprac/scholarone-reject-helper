import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCREENING_REJECT_MESSAGE } from "../src/default-screening-reject-message.js";

test("initial assessment live rejection uses the dedicated editorial message", () => {
  assert.match(DEFAULT_SCREENING_REJECT_MESSAGE, /^Dear Authors,/);
  assert.match(DEFAULT_SCREENING_REJECT_MESSAGE, /not to proceed with external peer review/);
  assert.match(DEFAULT_SCREENING_REJECT_MESSAGE, /Kind regards,\nEditorial Office$/);
  assert.doesNotMatch(DEFAULT_SCREENING_REJECT_MESSAGE, /availability of suitably qualified reviewers/i);
});
