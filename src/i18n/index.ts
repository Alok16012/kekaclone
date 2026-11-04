/**
 * Translation and formatting with no I/O: t(locale, key, vars) with {name} substitution and a small
 * {count, plural, one {…} other {…}} form; date/number formatters per locale. Pure and unit-tested.
 */
import { DEFAULT_LOCALE, INTL_TAG, MESSAGES, type Locale, type MessageKey } from "./messages";

export type Vars = Record<string, string | number | null | undefined>;
export const LOCALE_COOKIE = "erp_lang";

function plural(locale: Locale, n: number, forms: string): string {
  const pick = new Intl.PluralRules(INTL_TAG[locale]).select(n);
  const m = new Map<string, string>();
  for (const x of forms.matchAll(/(zero|one|two|few|many|other)\s*\{([^{}]*)\}/g)) m.set(x[1], x[2]);
  return (m.get(pick) ?? m.get("other") ?? "").replace(/#/g, formatNumber(locale, n));
}

export function format(locale: Locale, template: string, vars: Vars = {}): string {
  return template
    .replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g, (_, k: string, forms: string) => plural(locale, Number(vars[k] ?? 0), forms))
    .replace(/\{(\w+)\}/g, (_, k: string) => { const v = vars[k]; return v == null ? "" : String(v); });
}

/** Look a key up in the locale, falling back to English, then to the key itself. */
export function t(locale: Locale, key: MessageKey, vars?: Vars): string {
  const template = MESSAGES[locale][key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  return format(locale, template, vars);
}

export function formatNumber(locale: Locale, n: number, opts?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(INTL_TAG[locale], opts).format(n);
}

/** A calendar date (YYYY-MM-DD) in the locale, e.g. "Monday, 3 November" / "सोमवार, 3 नवंबर". */
export function formatDate(locale: Locale, iso: string, opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" }) {
  return new Intl.DateTimeFormat(INTL_TAG[locale], { ...opts, timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

export function formatTime(locale: Locale, isoInstant: string, tz = "Asia/Kolkata") {
  return new Intl.DateTimeFormat(INTL_TAG[locale], { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(isoInstant));
}

export { isLocale, LOCALES, LOCALE_LABELS, DEFAULT_LOCALE, type Locale, type MessageKey } from "./messages";
