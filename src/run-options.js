const MODE_FIELDS = {
  dryrun: [
    ["maxChecked", 1],
    ["submittedOlderThanDays", 1],
    ["queueStartPage", 1],
    ["slowMo", 0],
  ],
  live: [
    ["maxChecked", 1],
    ["submittedOlderThanDays", 1],
    ["queueStartPage", 1],
    ["slowMo", 0],
    ["maxRejected", 1],
  ],
  "send-from-report": [
    ["submittedOlderThanDays", 1],
    ["slowMo", 0],
    ["maxRejected", 1],
  ],
};

export function validateRunOptions(body, mode) {
  const fields = MODE_FIELDS[mode];
  if (!fields) {
    throw badRequest(`Nieznany tryb uruchomienia: ${mode}`);
  }

  validateStartUrl(body.startUrl);

  for (const [key, minimum] of fields) {
    validateOptionalInteger(body[key], key, minimum);
  }
}

function validateStartUrl(value) {
  if (isEmpty(value)) {
    return;
  }

  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw badRequest("Start URL musi byc poprawnym adresem http:// lub https://.");
  }
}

function validateOptionalInteger(value, key, minimum) {
  if (isEmpty(value)) {
    return;
  }

  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw badRequest(`${key} musi byc liczba calkowita.`);
  }

  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw badRequest(`${key} musi byc liczba calkowita nie mniejsza niz ${minimum}.`);
  }
}

function isEmpty(value) {
  return value === undefined || value === null || value === "";
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
