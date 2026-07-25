// Wspólny bezpiecznik operacji nieodwracalnych.
//
// --max-rejected chronił dotąd tylko odrzucanie z kolejki. Screening w trybie
// live i wysyłka zaproszeń nie miały odpowiednika, a --scan-all-metadata puszcza
// całą kolejkę — jedno przeoczenie w prompcie mogło skończyć się dziesiątkami
// wysłanych wiadomości.
export class LiveActionLimitReached extends Error {
  constructor(limit, action) {
    super(`Osiągnięto limit ${limit} operacji nieodwracalnych (${action}). Przebieg zatrzymany.`);
    this.name = "LiveActionLimitReached";
    this.code = "LIVE_ACTION_LIMIT";
    this.limit = limit;
  }
}

export function createLiveGuard({ limit = null, onLimit = null } = {}) {
  const effectiveLimit = Number.isFinite(limit) && limit > 0 ? limit : null;
  let performed = 0;

  return {
    get performed() {
      return performed;
    },
    get limit() {
      return effectiveLimit;
    },
    get remaining() {
      return effectiveLimit === null ? Infinity : Math.max(0, effectiveLimit - performed);
    },

    // Wołane PRZED akcją. Wyczerpany limit zatrzymuje przebieg, zamiast wykonać
    // operację i dopiero potem zauważyć, że była o jedną za dużo.
    assertCanProceed(action = "akcja") {
      if (effectiveLimit !== null && performed >= effectiveLimit) {
        onLimit?.(effectiveLimit, action);
        throw new LiveActionLimitReached(effectiveLimit, action);
      }
    },

    // Wołane PO potwierdzeniu skutku, nie po samym kliknięciu.
    recordPerformed() {
      performed += 1;
      return performed;
    },

    describe() {
      return effectiveLimit === null ? `${performed}` : `${performed}/${effectiveLimit}`;
    },
  };
}

export function isLiveActionLimit(error) {
  return error?.code === "LIVE_ACTION_LIMIT";
}
