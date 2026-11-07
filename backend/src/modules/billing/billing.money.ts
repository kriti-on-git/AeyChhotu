/* Billing money arithmetic.

   Currency NEVER passes through binary floating point. Database `numeric`
   values arrive as decimal strings; they are parsed into integer paise, all
   arithmetic stays in integers, and only the final DTO is formatted back to a
   two-decimal string. `0.10 × 3` therefore produces `"0.30"`, not
   `0.30000000000000004`. */

/** Parse a decimal money string (or safe numeric value) into integer paise. */
export function toMinor(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Money must be a finite value.");
    }
    value = String(value);
  }

  const text = value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new Error(`Money must be a non-negative decimal with at most 2 places: "${value}".`);
  }

  const whole = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  const minor = whole * 100 + cents;

  if (!Number.isSafeInteger(minor)) {
    throw new Error("Money exceeds the supported range.");
  }
  return minor;
}

/** Format integer paise as a fixed two-decimal string. */
export function formatMinor(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new Error("Money must be an integer number of paise.");
  }
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  const whole = Math.trunc(absolute / 100);
  const cents = absolute % 100;
  return `${sign}${whole}.${String(cents).padStart(2, "0")}`;
}

/** Round a non-negative rational to the nearest integer, halves up. */
export function roundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new Error("Rounding inputs must be integers.");
  }
  if (numerator < 0 || denominator <= 0) {
    throw new Error("Rounding expects a non-negative numerator and positive denominator.");
  }
  return Math.floor((numerator + Math.trunc(denominator / 2)) / denominator);
}

/** Tax in paise from a paise subtotal and a basis-point rate. */
export function taxMinor(subtotalMinor: number, rateBps: number): number {
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new Error("The tax rate must be a non-negative integer in basis points.");
  }
  return roundHalfUp(subtotalMinor * rateBps, 10_000);
}
