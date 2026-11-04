import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor } from "@/server/auth/permissions";
import { todayIn } from "@/lib/dates";
import { EVERYWHERE, EXP_ADMIN, EXP_PAYOUT } from "./access";
import { audit } from "./admin";
import { convertToInr, isCurrencyCode, parseRateMicro, rateFor, ratesFromProvider, rateText, type RateRow } from "./fx-rules";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));

/** Rates are company-wide: finance (payouts) or expense admins without a scope keep them. */
export const canManageRates = (actor: Actor) => canFor(actor, EXP_PAYOUT, EVERYWHERE) || canFor(actor, EXP_ADMIN, EVERYWHERE);

export type FxRateView = { id: string; currency: string; asOf: string; rateMicro: number; rate: string; source: "manual" | "fetched"; createdAt: string };

export async function listRates(tx: Tx): Promise<FxRateView[]> {
  const rows = await tx<{ id: string; currency: string; as_of: string; rate_micro: bigint; source: "manual" | "fetched"; created_at: Date }[]>`
    select id, currency, as_of::text, rate_micro, source, created_at from fx_rates order by currency, as_of desc`;
  return rows.map((r) => ({ id: r.id, currency: r.currency, asOf: r.as_of, rateMicro: N(r.rate_micro), rate: rateText(N(r.rate_micro)), source: r.source, createdAt: r.created_at.toISOString() }));
}

async function rateRows(tx: Tx): Promise<RateRow[]> {
  const rows = await tx<{ currency: string; as_of: string; rate_micro: bigint; source: "manual" | "fetched" }[]>`select currency, as_of::text, rate_micro, source from fx_rates`;
  return rows.map((r) => ({ currency: r.currency, asOf: r.as_of, rateMicro: N(r.rate_micro), source: r.source }));
}

/** Currencies with at least one rate (what the expense form offers besides INR). */
export async function currenciesWithRates(tx: Tx) {
  return (await tx<{ currency: string }[]>`select distinct currency from fx_rates order by currency`).map((r) => r.currency);
}

/** INR paise for a foreign amount on a date, with the rate used. Throws when finance hasn't set a rate for the currency. */
export async function convert(tx: Tx, amountMinor: number, currency: string, date: string) {
  const code = currency.toUpperCase();
  if (code === "INR") return { currency: "INR", rateMicro: 1_000_000, asOf: date, inrPaise: amountMinor };
  if (!isCurrencyCode(code)) throw new AppError("invalid", "Pick a currency.", "currency");
  const r = rateFor(await rateRows(tx), code, date);
  if (!r) throw new AppError("invalid", `There's no exchange rate for ${code} yet. Ask finance to add one under Settings → Expenses.`, "currency");
  return { currency: code, rateMicro: r.rateMicro, asOf: r.asOf, inrPaise: convertToInr(amountMinor, r.rateMicro) };
}

/** Add or replace the rate for a currency on a date (one row per currency and date). */
export async function saveRate(tx: Tx, actor: Actor, input: { currency: string; asOf: string; rate: string }) {
  if (!canManageRates(actor)) throw new AppError("forbidden", "Only finance or expense admins for the whole company can change exchange rates.");
  const currency = String(input.currency ?? "").trim().toUpperCase();
  if (!isCurrencyCode(currency) || currency === "INR") throw new AppError("invalid", "Use a 3-letter currency code other than INR, like USD.", "currency");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf) || Number.isNaN(Date.parse(input.asOf + "T00:00:00Z"))) throw new AppError("invalid", "Pick the date the rate applies from.", "asOf");
  const micro = parseRateMicro(input.rate);
  if (micro == null) throw new AppError("invalid", "Enter the rate as INR per unit, like 83.25 (up to 6 decimals).", "rate");
  const [r] = await tx<{ id: string }[]>`
    insert into fx_rates (tenant_id, currency, as_of, rate_micro, source, created_by) values (${actor.tenant.id}, ${currency}, ${input.asOf}, ${micro}, 'manual', ${actor.userId})
    on conflict (tenant_id, currency, as_of) do update set rate_micro = excluded.rate_micro, source = 'manual', created_by = excluded.created_by, updated_at = now() returning id`;
  await audit(tx, actor, "fx_rate", r.id, "save", { currency, asOf: input.asOf, rateMicro: micro });
  return { id: r.id };
}

export async function deleteRate(tx: Tx, actor: Actor, id: string) {
  if (!canManageRates(actor)) throw new AppError("forbidden", "Only finance or expense admins for the whole company can change exchange rates.");
  const [r] = await tx<{ currency: string; as_of: string }[]>`delete from fx_rates where id = ${id} returning currency, as_of::text`;
  if (!r) throw new AppError("not_found", "Rate not found.");
  await audit(tx, actor, "fx_rate", id, "delete", { currency: r.currency, asOf: r.as_of });
}

// ---------------------------------------------------------------- daily fetch (behind an interface; off until configured)

/** Where daily rates come from: FX_RATES_URL, a JSON endpoint answering { base, date?, rates: { USD: … } }. Without it, rates are typed in by finance. */
export function fxFetchStatus() {
  const url = process.env.FX_RATES_URL?.trim();
  return url ? { configured: true as const, url } : { configured: false as const, reason: "FX_RATES_URL isn't set. Daily rate fetching is off; finance enters rates by hand." };
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** The daily job: pull today's rates from the provider and store them as fetched rows (never overwriting a rate finance typed for the same day). */
export async function fetchDailyRates(tx: Tx, tenantId: string, today = todayIn(), fetchImpl: Fetcher = fetch) {
  const s = fxFetchStatus();
  if (!s.configured) return { configured: false, stored: 0 };
  let body: unknown;
  try {
    const res = await fetchImpl(s.url);
    if (!res.ok) throw new Error(`provider answered ${res.status}`);
    body = await res.json();
  } catch (e) { throw new Error(`Exchange rates couldn't be fetched: ${(e as Error).message}`); }
  const rows = ratesFromProvider(body, today);
  let stored = 0;
  for (const r of rows) {
    const ins = await tx`insert into fx_rates (tenant_id, currency, as_of, rate_micro, source) values (${tenantId}, ${r.currency}, ${r.asOf}, ${r.rateMicro}, 'fetched')
      on conflict (tenant_id, currency, as_of) do update set rate_micro = excluded.rate_micro, updated_at = now() where fx_rates.source = 'fetched'`;
    stored += ins.count;
  }
  return { configured: true, stored };
}
