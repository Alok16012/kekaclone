/**
 * Receipt text → amount, date and merchant (pure, no I/O). The text comes from OCR (see ./index.ts), so it is noisy:
 * every guess carries a confidence and the person always gets to change it. Nothing here blocks a claim.
 */

export type ReceiptGuess = {
  amountPaise: number | null; date: string | null; merchant: string | null;
  /** 0–100: how sure the parser is about each field, and overall (the OCR engine's own confidence is folded in by the caller) */
  confidence: { amount: number; date: number; merchant: number };
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const TOTAL_WORDS = /\b(grand\s*total|net\s*(amount|payable|total)|total\s*(amount|payable|due)?|amount\s*(payable|due|paid)|balance\s*due|to\s*pay|payable)\b/i;
const NOT_TOTAL = /\b(sub\s*-?\s*total|subtotal|discount|tax|gst|cgst|sgst|igst|vat|tip|change|cash\s*tendered|tendered|round)\b/i;
const MONEY = /(?:₹|rs\.?|inr)?\s*(\d{1,3}(?:[,\s]\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:\/-)?/gi;

const toPaise = (s: string) => {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.replace(/[,\s]/g, ""));
  if (!m) return null;
  const p = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(p) && p > 0 && p <= 10_000_000_00 ? p : null;
};

/** Amounts on a line, in paise, left to right. */
function amountsOn(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(MONEY)) {
    const raw = m[1];
    // bare small integers without a currency mark or decimals are usually quantities, not money
    if (!/[₹]|rs|inr/i.test(m[0]) && !raw.includes(".") && raw.replace(/[,\s]/g, "").length < 3) continue;
    const p = toPaise(raw);
    if (p) out.push(p);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d: number) => {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const year = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));

/** First date-like thing in the text: 12/03/2026, 12-03-26, 2026-03-12, 12 Mar 2026, March 12, 2026. Indian receipts are day-first. */
export function parseDate(text: string): { date: string; confidence: number } | null {
  const t = text.replace(/\s+/g, " ");
  let m: RegExpMatchArray | null;
  if ((m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t))) { const d = valid(Number(m[1]), Number(m[2]), Number(m[3])); if (d) return { date: d, confidence: 85 }; }
  if ((m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(t))) {
    const a = Number(m[1]), b = Number(m[2]), y = year(m[3]);
    const dayFirst = valid(y, b, a), monthFirst = valid(y, a, b);
    if (dayFirst) return { date: dayFirst, confidence: monthFirst && a <= 12 && b <= 12 && a !== b ? 60 : 85 };
    if (monthFirst) return { date: monthFirst, confidence: 55 };
  }
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]*([a-z]{3,9})[\s,.-]*(\d{2,4})\b/i.exec(t))) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) { const d = valid(year(m[3]), mo, Number(m[1])); if (d) return { date: d, confidence: 80 }; }
  }
  if ((m = /\b([a-z]{3,9})[\s.]*(\d{1,2})(?:st|nd|rd|th)?[\s,]*(\d{4})\b/i.exec(t))) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) { const d = valid(Number(m[3]), mo, Number(m[2])); if (d) return { date: d, confidence: 75 }; }
  }
  return null;
}

/** The total: the amount on a "total"-like line (last such line wins), else the largest amount with a currency mark, else the largest amount. */
export function parseAmount(text: string): { amountPaise: number; confidence: number } | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let best: { amountPaise: number; confidence: number } | null = null;
  for (const [i, l] of lines.entries()) {
    if (!TOTAL_WORDS.test(l) || NOT_TOTAL.test(l)) continue;
    const here = amountsOn(l);
    const next = here.length ? here : amountsOn(lines[i + 1] ?? "");   // "TOTAL" on one line, the figure on the next
    if (!next.length) continue;
    const amountPaise = next[next.length - 1];
    const strong = /grand\s*total|net\s*(amount|payable)|amount\s*(payable|paid)/i.test(l);
    best = { amountPaise, confidence: strong ? 90 : 75 };
  }
  if (best) return best;
  const marked = lines.flatMap((l) => (/[₹]|\brs\b|\binr\b/i.test(l) ? amountsOn(l) : []));
  if (marked.length) return { amountPaise: Math.max(...marked), confidence: 50 };
  const all = lines.flatMap(amountsOn);
  return all.length ? { amountPaise: Math.max(...all), confidence: 30 } : null;
}

const NOISE = /^(tax\s*invoice|invoice|receipt|bill|cash\s*memo|gstin|gst\s*no|tin|phone|ph|tel|mobile|date|time|table|order|bill\s*no|www\.|http|thank)/i;
/** The merchant: the first substantial line near the top that isn't a date, number, address-ish or boilerplate line. */
export function parseMerchant(text: string): { merchant: string; confidence: number } | null {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/[^\p{L}\p{N} &'.,\-/]/gu, " ").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
  for (const [i, l] of lines.entries()) {
    const letters = (l.match(/\p{L}/gu) ?? []).length;
    if (letters < 3 || letters < l.length * 0.5 || NOISE.test(l) || parseDate(l)) continue;
    if (/\d{5,}/.test(l)) continue;   // phone numbers, GSTINs
    return { merchant: l.slice(0, 120), confidence: i === 0 ? 70 : 55 };
  }
  return null;
}

export function parseReceipt(text: string): ReceiptGuess {
  const a = parseAmount(text), d = parseDate(text), m = parseMerchant(text);
  return { amountPaise: a?.amountPaise ?? null, date: d?.date ?? null, merchant: m?.merchant ?? null, confidence: { amount: a?.confidence ?? 0, date: d?.confidence ?? 0, merchant: m?.confidence ?? 0 } };
}

/** Field confidence scaled by the OCR engine's own confidence (0–100), as whole percentages. */
export function scaleConfidence(g: ReceiptGuess, engine: number): ReceiptGuess {
  const f = Math.max(0, Math.min(100, engine)) / 100;
  const s = (v: number) => Math.round(v * (0.5 + 0.5 * f));
  return { ...g, confidence: { amount: s(g.confidence.amount), date: s(g.confidence.date), merchant: s(g.confidence.merchant) } };
}
