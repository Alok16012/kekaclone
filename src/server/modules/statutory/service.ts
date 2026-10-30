import "server-only";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { can, canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import {
  CONFIG_SCHEMAS, type EsiConfig, type GratuityConfig, type IncomeTaxConfig, type LwfConfig, type PfConfig, type PtConfig, type RateKind, type RateRow,
} from "./config";
import { RATE_ROWS } from "./rates-data";
import { fyOf } from "./rules";

/** Anything that runs queries: a tenant transaction, the app pool, or the admin connection used by jobs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = Tx | postgres.Sql<any>;
/** Both are tagged-template query functions; TS can't call through the union, so narrow once. */
const q = (db: Db) => db as unknown as Tx;

const PERM = "payroll.admin";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/** Recording a CA verification is a company-wide statement, so it needs payroll.admin without a scope. */
export const canRecordVerification = (actor: Actor) => canFor(actor, PERM, EVERYWHERE);
/** Rates are global and read-only; anyone who works on payroll or company settings may look at them. */
export const canViewRates = (actor: Actor) => can(actor, PERM) || can(actor, "settings.org");

export type Rate<C> = { id: string; kind: RateKind; stateCode: string | null; regime: "old" | "new" | null; effectiveFrom: string; effectiveTo: string | null; sourceNote: string; config: C; updatedAt: string };

type RawRow = { id: string; kind: RateKind; state_code: string | null; regime: "old" | "new" | null; effective_from: string; effective_to: string | null; source_note: string; config: unknown; updated_at: string };

function parseRow(r: RawRow): Rate<unknown> {
  const schema = CONFIG_SCHEMAS[r.kind];
  if (!schema) throw new AppError("invalid", `Unknown statutory rate kind “${r.kind}”.`);
  const parsed = schema.safeParse(r.config);
  if (!parsed.success) throw new AppError("invalid", `The ${r.kind} rates from ${r.effective_from} are malformed: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
  return { id: r.id, kind: r.kind, stateCode: r.state_code, regime: r.regime, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, sourceNote: r.source_note, config: parsed.data, updatedAt: r.updated_at };
}

export type EffectiveRates = {
  date: ISODate; fy: string; stateCode: string | null;
  pf: Rate<PfConfig>; esi: Rate<EsiConfig>; gratuity: Rate<GratuityConfig>;
  incomeTax: { old: Rate<IncomeTaxConfig>; new: Rate<IncomeTaxConfig> };
  /** null when the state has no professional tax / LWF in erp (or no state is given). */
  pt: Rate<PtConfig> | null; lwf: Rate<LwfConfig> | null;
};

const LABEL: Record<RateKind, string> = { pf: "PF", esi: "ESI", pt: "professional tax", lwf: "labour welfare fund", gratuity: "gratuity", income_tax: "income tax" };

/**
 * Every rate the payroll engine needs on `date`, for a person working in `state` (PT/LWF state code, e.g. "KA").
 * Configs are validated; a missing national rate is an error rather than a silent zero.
 */
export async function loadRates(db: Db, date: ISODate, state?: string | null): Promise<EffectiveRates> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError("invalid", "Pick a valid date.");
  const st = state ? state.toUpperCase() : null;
  const rows = (await q(db)<RawRow[]>`
    select id, kind, state_code, regime, effective_from::text, effective_to::text, source_note, config, updated_at::text from statutory_rates
    where effective_from <= ${date}::date and (effective_to is null or effective_to >= ${date}::date)
      and (state_code is null or state_code = ${st})
    order by effective_from desc`).map(parseRow);
  const pick = <C>(kind: RateKind, regime: string | null = null, withState = false) =>
    rows.find((r) => r.kind === kind && r.regime === regime && (withState ? r.stateCode === st : r.stateCode == null)) as Rate<C> | undefined;
  const need = <C>(kind: RateKind, regime: string | null = null) => {
    const r = pick<C>(kind, regime);
    if (!r) throw new AppError("not_found", `No ${LABEL[kind]}${regime ? ` (${regime} regime)` : ""} rates are set up for ${date}.`);
    return r;
  };
  return {
    date, fy: fyOf(date), stateCode: st,
    pf: need<PfConfig>("pf"), esi: need<EsiConfig>("esi"), gratuity: need<GratuityConfig>("gratuity"),
    incomeTax: { old: need<IncomeTaxConfig>("income_tax", "old"), new: need<IncomeTaxConfig>("income_tax", "new") },
    pt: st ? pick<PtConfig>("pt", null, true) ?? null : null,
    lwf: st ? pick<LwfConfig>("lwf", null, true) ?? null : null,
  };
}

/** Income-tax rates for a financial year ("2025-26") and regime. */
export async function loadTaxRates(db: Db, fy: string, regime: "old" | "new"): Promise<Rate<IncomeTaxConfig>> {
  const rows = (await q(db)<RawRow[]>`select id, kind, state_code, regime, effective_from::text, effective_to::text, source_note, config, updated_at::text from statutory_rates where kind = 'income_tax' and regime = ${regime} and config->>'fy' = ${fy} order by effective_from desc limit 1`).map(parseRow);
  if (!rows[0]) throw new AppError("not_found", `No income tax rates are set up for FY ${fy} (${regime} regime).`);
  return rows[0] as Rate<IncomeTaxConfig>;
}

/** Every version of every rate, for the settings page. */
export async function listRates(db: Db) {
  return (await q(db)<RawRow[]>`select id, kind, state_code, regime, effective_from::text, effective_to::text, source_note, config, updated_at::text from statutory_rates order by kind, state_code nulls first, regime nulls first, effective_from desc`).map(parseRow);
}

/** A stable hash of the whole statutory_rates table: any change to any rate changes it. */
export async function ratesFingerprint(db: Db) {
  const rows = await q(db)<{ kind: string; state_code: string | null; regime: string | null; effective_from: string; effective_to: string | null; config: unknown }[]>`
    select kind, state_code, regime, effective_from::text, effective_to::text, config::text as config from statutory_rates
    order by kind, coalesce(state_code, ''), coalesce(regime, ''), effective_from`;
  const h = createHash("sha256");
  for (const r of rows) h.update(JSON.stringify([r.kind, r.state_code, r.regime, r.effective_from, r.effective_to, r.config]) + "\n");
  return { fingerprint: h.digest("hex"), count: rows.length };
}

// ---------------------------------------------------------------- CA verification (per company)
export type Verification = { id: string; verified_by_name: string; verified_on: string; note: string; recorded_at: string; recorded_by_name: string | null; rates_fingerprint: string; rates_count: number };

export async function listVerifications(tx: Tx) {
  return tx<Verification[]>`
    select v.id, v.verified_by_name, v.verified_on::text, v.note, v.created_at::text as recorded_at, v.rates_fingerprint, v.rates_count,
           coalesce(e.display_name, u.email::text) as recorded_by_name
    from statutory_verifications v left join users u on u.id = v.recorded_by left join employees e on e.user_id = v.recorded_by
    where v.tenant_id = app_tenant()
    order by v.created_at desc, v.id limit 50`;
}

export type VerificationStatus = { verified: boolean; stale: boolean; latest: Verification | null; fingerprint: string; count: number };

/**
 * Whether this company has a CA verification for the rates as they are now. Payroll screens show the
 * "unverified" banner unless `verified` is true; a rate change makes an older verification `stale`.
 */
export async function verificationStatus(tx: Tx): Promise<VerificationStatus> {
  const fp = await ratesFingerprint(tx);
  const [current] = await tx<Verification[]>`
    select v.id, v.verified_by_name, v.verified_on::text, v.note, v.created_at::text as recorded_at, v.rates_fingerprint, v.rates_count,
           coalesce(e.display_name, u.email::text) as recorded_by_name
    from statutory_verifications v left join users u on u.id = v.recorded_by left join employees e on e.user_id = v.recorded_by
    where v.tenant_id = app_tenant() and v.rates_fingerprint = ${fp.fingerprint} order by v.created_at desc limit 1`;
  if (current) return { verified: true, stale: false, latest: current, ...fp };
  const [latest] = await listVerifications(tx);
  return { verified: false, stale: !!latest, latest: latest ?? null, ...fp };
}

/** Shorthand for payroll screens: true when the warning banner should be shown. */
export async function ratesNeedVerification(tx: Tx) {
  return !(await verificationStatus(tx)).verified;
}

export const verificationInput = z.object({
  verifiedByName: z.string().trim().min(2, "Enter the CA or firm who checked the rates.").max(200),
  verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date they signed off."),
  note: z.string().trim().min(5, "Add a short note (for example the membership number or what was checked).").max(2000),
  confirm: z.literal(true, { error: "Confirm that a CA reviewed every rate on this page." }),
  /** The fingerprint the person was looking at; refused if the rates changed in the meantime. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type VerificationInput = z.input<typeof verificationInput>;

/**
 * Record that a CA checked the current rates. payroll.admin without a scope. Idempotent: the same rates
 * can be recorded once per company; repeating returns the existing record.
 */
export async function recordVerification(tx: Tx, actor: Actor, input: VerificationInput, today = todayIn()) {
  if (!canRecordVerification(actor)) throw new AppError("forbidden", "Only payroll admins with company-wide access can record a CA verification.");
  const p = verificationInput.safeParse(input);
  if (!p.success) { const i = p.error.issues[0]; throw new AppError("invalid", i?.message ?? "Check the details.", String(i?.path[0] ?? "")); }
  const v = p.data;
  if (v.verifiedOn > today) throw new AppError("invalid", "The sign-off date can't be in the future.", "verifiedOn");
  if (v.verifiedOn < addDaysISO(today, -366)) throw new AppError("invalid", "That sign-off is more than a year old. Ask your CA to check the current rates.", "verifiedOn");
  const fp = await ratesFingerprint(tx);
  if (fp.count === 0) throw new AppError("invalid", "There are no statutory rates to verify yet.");
  if (fp.fingerprint !== v.fingerprint) throw new AppError("conflict", "The rates changed while you were looking at them. Reload the page and check them again.");
  const [row] = await tx<{ id: string }[]>`
    insert into statutory_verifications (tenant_id, verified_by_name, verified_on, note, rates_fingerprint, rates_count, recorded_by)
    values (${actor.tenant.id}, ${v.verifiedByName}, ${v.verifiedOn}, ${v.note}, ${fp.fingerprint}, ${fp.count}, ${actor.userId})
    on conflict (tenant_id, rates_fingerprint) do nothing returning id`;
  if (!row) {
    const [existing] = await tx<{ id: string }[]>`select id from statutory_verifications where tenant_id = ${actor.tenant.id} and rates_fingerprint = ${fp.fingerprint}`;
    return { id: existing.id, alreadyRecorded: true };
  }
  await audit(tx, actor, { entityType: "statutory_verification", entityId: row.id, action: "statutory.verified", diff: { verifiedByName: v.verifiedByName, verifiedOn: v.verifiedOn, ratesCount: fp.count } });
  return { id: row.id, alreadyRecorded: false };
}

// ---------------------------------------------------------------- writing the global table (admin connection only)
/**
 * Make statutory_rates match rates-data.ts: insert missing versions, update changed ones. Never deletes (old
 * versions stay for finalized months). Needs the admin connection — the app role can only read this table.
 */
export async function syncStatutoryRates(db: Db, rows: RateRow[] = RATE_ROWS) {
  const admin = q(db);
  let inserted = 0, updated = 0;
  for (const r of rows) {
    CONFIG_SCHEMAS[r.kind].parse(r.config);
    const [cur] = await admin<{ id: string; same: boolean }[]>`
      select id, (config = ${admin.json(r.config as never)}::jsonb and source_note = ${r.sourceNote} and effective_to is not distinct from ${r.effectiveTo}::date) as same
      from statutory_rates where kind = ${r.kind} and coalesce(state_code, '') = ${r.stateCode ?? ""} and coalesce(regime, '') = ${r.regime ?? ""} and effective_from = ${r.effectiveFrom}`;
    if (!cur) {
      await admin`insert into statutory_rates (kind, state_code, regime, effective_from, effective_to, config, source_note)
                  values (${r.kind}, ${r.stateCode}, ${r.regime}, ${r.effectiveFrom}, ${r.effectiveTo}, ${admin.json(r.config as never)}, ${r.sourceNote})`;
      inserted++;
    } else if (!cur.same) {
      await admin`update statutory_rates set config = ${admin.json(r.config as never)}, source_note = ${r.sourceNote}, effective_to = ${r.effectiveTo}, updated_at = now() where id = ${cur.id}`;
      updated++;
    }
  }
  return { inserted, updated, total: rows.length };
}
