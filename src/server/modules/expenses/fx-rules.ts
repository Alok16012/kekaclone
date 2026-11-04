/**
 * Multi-currency expenses (pure, no I/O). Rates are "INR per one unit of the currency", kept as integers in
 * millionths (rate_micro) so the conversion is exact: 1 USD = 83.254321 INR → 83_254_321. Policy limits are in INR,
 * so every foreign amount is converted once, at entry, and the INR figure is what claims, approvals and payroll use.
 */

/** Currencies erp knows how to label. Any other 3-letter ISO code can still be added to the rates table. */
export const CURRENCIES: { code: string; name: string }[] = [
  ["INR", "Indian rupee"], ["USD", "US dollar"], ["EUR", "Euro"], ["GBP", "British pound"], ["AED", "UAE dirham"], ["SGD", "Singapore dollar"],
  ["AUD", "Australian dollar"], ["CAD", "Canadian dollar"], ["JPY", "Japanese yen"], ["CHF", "Swiss franc"], ["SAR", "Saudi riyal"], ["QAR", "Qatari riyal"],
  ["MYR", "Malaysian ringgit"], ["THB", "Thai baht"], ["LKR", "Sri Lankan rupee"], ["NPR", "Nepalese rupee"], ["BDT", "Bangladeshi taka"], ["HKD", "Hong Kong dollar"],
  ["NZD", "New Zealand dollar"], ["SEK", "Swedish krona"], ["ZAR", "South African rand"], ["CNY", "Chinese yuan"],
].map(([code, name]) => ({ code, name }));
export const isCurrencyCode = (s: string) => /^[A-Z]{3}$/.test(s);
export const currencyName = (code: string) => CURRENCIES.find((c) => c.code === code)?.name ?? code;

/** "83.25", "83.254321", "1,234.5" → rate in millionths (INR per unit). Null for anything that isn't a positive number with up to 6 decimals. */
export function parseRateMicro(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(String(input).replace(/[,\s]/g, ""));
  if (!m) return null;
  const micro = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  return micro > 0 ? micro : null;
}
/** Millionths → "83.254321" (trailing zeros trimmed to at least two decimals). */
export function rateText(micro: number) {
  const whole = Math.floor(micro / 1_000_000), frac = String(micro % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${frac.length < 2 ? frac.padEnd(2, "0") : frac}`;
}

/** Foreign amount (minor units, e.g. cents) × rate → INR paise, rounded half up. Exact integer maths. */
export function convertToInr(amountMinor: number, rateMicro: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !Number.isSafeInteger(rateMicro) || rateMicro <= 0) throw new RangeError("amount and rate must be whole non-negative integers");
  const n = BigInt(amountMinor) * BigInt(rateMicro), d = BigInt(1_000_000);
  return Number((BigInt(2) * n + d) / (BigInt(2) * d));
}

export type RateRow = { currency: string; asOf: string; rateMicro: number; source: "manual" | "fetched" };
/** The rate to use on a date: the latest dated on or before it, else the earliest after it (so a new currency still converts). */
export function rateFor(rates: RateRow[], currency: string, date: string): RateRow | null {
  const mine = rates.filter((r) => r.currency === currency).sort((a, b) => a.asOf.localeCompare(b.asOf));
  if (!mine.length) return null;
  const before = mine.filter((r) => r.asOf <= date);
  return before.length ? before[before.length - 1] : mine[0];
}

/** Rate rows from a provider's JSON ({ base: "INR"|other, date, rates: {USD: 0.012, …} }). INR-based providers quote units per INR, so invert. */
export function ratesFromProvider(body: unknown, asOf: string): RateRow[] {
  const b = (body ?? {}) as { base?: unknown; rates?: Record<string, unknown> };
  const rates = b.rates && typeof b.rates === "object" ? b.rates : {};
  const out: RateRow[] = [];
  const base = typeof b.base === "string" ? b.base.toUpperCase() : "INR";
  const inrPerBase = base === "INR" ? 1 : typeof rates.INR === "number" && rates.INR > 0 ? rates.INR : null;
  if (inrPerBase == null) return out;
  for (const [cur, v] of Object.entries(rates)) {
    const code = cur.toUpperCase();
    if (!isCurrencyCode(code) || code === "INR" || typeof v !== "number" || !(v > 0)) continue;
    // INR per unit of `code` = (INR per base) / (units of `code` per base)
    const micro = Math.round((inrPerBase / v) * 1_000_000);
    if (micro > 0 && Number.isSafeInteger(micro)) out.push({ currency: code, asOf, rateMicro: micro, source: "fetched" });
  }
  return out;
}
