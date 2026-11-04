import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { validateUpload } from "@/server/modules/documents/rules";
import { saveFile } from "@/server/storage";
import { todayIn } from "@/lib/dates";
import { canPayrollFor, isPayrollAdmin, hasAnyPayrollAdmin, placementOf } from "@/server/modules/payroll/access";
import { getActiveSalary, getStatutoryProfile } from "@/server/modules/payroll/salary";
import { decryptField, encryptField } from "@/server/modules/payroll/secret";
import { loadRates, loadTaxRates, verificationStatus } from "@/server/modules/statutory/service";
import { compareRegimes, professionalTax, type AnnualTaxResult, type TaxDeductions } from "@/server/modules/statutory/rules";
import type { Placement } from "@/server/auth/permissions";
import {
  annualRent, checkRentPeriods, checkTaxSettings, countedPaise, daysEmployed, declarationWindow, EMPTY_OTHER, EMPTY_PREVIOUS, fyEnd, fyLabel, fyMonths,
  fyStartOf, HOME_LOAN_ITEM, hraExemption, inr, isKnownItem, isPan, itemLabel, ITEMS, limitsFor, normalisePan, otherIncomeTotal, panFromFileName, parseTaxSettings,
  projectSalary, proofsFinal, proofWindow, readHouse, readOther, readPrevious, rentByMonth, sectionTotals, toTaxDeductions,
  type HouseProperty, type ItemRow, type OtherIncome, type PreviousEmployer, type RentPeriod, type SectionTotals, type TaxSettings, type WindowState,
} from "./rules";
import { readZip, ZipError } from "./zip";
import { fbpFor } from "./fbp";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));
const bad = (message: string, field?: string) => new AppError("invalid", message, field);
type Person = Placement & { id: string; display_name: string; first_name: string; status: string; joining_date: string; exit_date: string | null; pay_group_id: string | null; employee_number: string | null; user_id: string | null; designation: string | null };

async function person(tx: Tx, id: string): Promise<Person> {
  const [p] = await tx<Person[]>`
    select e.id, e.display_name, e.first_name, e.status, e.joining_date::text, e.exit_date::text, e.pay_group_id, e.employee_number, e.user_id,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, d.title as designation
    from employees e left join designations d on d.id = e.designation_id where e.id = ${id}`;
  if (!p) throw new AppError("not_found", "Person not found.");
  return p;
}

const isFyStart = (s: string) => /^\d{4}-04-01$/.test(s);
function assertFy(fyStart: string) { if (!isFyStart(fyStart)) throw bad("Pick a financial year."); }

/** Financial years someone can look at: from the year they joined (or two back) to the current one, plus next year from March. */
export function fyOptions(today: string, joiningDate: string | null) {
  const cur = fyStartOf(today);
  const first = joiningDate ? fyStartOf(joiningDate) : cur;
  const out: string[] = [];
  const last = Number(today.slice(5, 7)) === 3 ? Number(cur.slice(0, 4)) + 1 : Number(cur.slice(0, 4));
  for (let y = last; y >= Math.max(Number(first.slice(0, 4)), Number(cur.slice(0, 4)) - 3); y--) out.push(`${y}-04-01`);
  return out.map((v) => ({ value: v, label: `FY ${fyLabel(v)}` }));
}

// ---------------------------------------------------------------- settings
export async function settingsFor(tx: Tx, payGroupId: string | null): Promise<TaxSettings> {
  if (!payGroupId) return parseTaxSettings({});
  const [g] = await tx<{ tax_settings: unknown }[]>`select tax_settings from pay_groups where id = ${payGroupId}`;
  return parseTaxSettings(g?.tax_settings);
}

export async function listTaxSettings(tx: Tx) {
  const rows = await tx<{ id: string; name: string; tax_settings: unknown; people: number }[]>`
    select g.id, g.name, g.tax_settings, (select count(*)::int from employees e where e.pay_group_id = g.id and e.status <> 'relieved') as people from pay_groups g order by g.name`;
  return rows.map((r) => ({ id: r.id, name: r.name, people: r.people, settings: parseTaxSettings(r.tax_settings) }));
}

const md = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Pick a day and month.");
const settingsInput = z.object({
  editWindow: z.discriminatedUnion("mode", [z.object({ mode: z.literal("always") }), z.object({ mode: z.literal("monthly"), fromDay: z.number().int(), toDay: z.number().int() })]),
  declarationCutoff: md.nullable(),
  proofWindow: z.object({ opens: md, closes: md }).nullable(),
  lateJoinerDays: z.number().int(),
  fbpWindow: z.object({ opens: md, closes: md }).nullable().optional(),
});

/** Declaration windows are company policy for the whole pay group: payroll.admin without a scope. */
export async function saveTaxSettings(tx: Tx, actor: Actor, payGroupId: string, raw: unknown) {
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can change declaration windows.");
  const p = settingsInput.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const c = checkTaxSettings({ ...p.data, fbpWindow: p.data.fbpWindow ?? null });
  if (!c.ok) throw bad(c.error, c.field);
  const r = await tx`update pay_groups set tax_settings = ${tx.json(c.settings as never)}, updated_at = now() where id = ${payGroupId}`;
  if (!r.count) throw new AppError("not_found", "Pay group not found.");
  await audit(tx, actor, { entityType: "pay_group", entityId: payGroupId, action: "tax.settings", diff: c.settings });
}

// ---------------------------------------------------------------- PAN
const panScope = (tenantId: string, employeeId: string) => ["identity", tenantId, employeeId, "pan"];

export async function panFor(tx: Tx, employeeId: string) {
  const [r] = await tx<{ number_last4: string | null }[]>`select number_last4 from employee_identities where employee_id = ${employeeId} and kind = 'pan'`;
  return r ? { last4: r.number_last4 } : null;
}

/** Your own PAN, or someone's as their payroll admin. Stored encrypted; only the last 4 characters are ever shown. */
export async function savePan(tx: Tx, actor: Actor, employeeId: string, raw: string) {
  const p = await person(tx, employeeId);
  if (employeeId !== actor.employeeId && !canPayrollFor(actor, p)) throw new AppError("forbidden", "You can't change this person's PAN.");
  const pan = normalisePan(raw ?? "");
  if (!isPan(pan)) throw bad("A PAN has 10 characters: 5 letters, 4 digits and a letter (like ABCDE1234F).", "pan");
  const dup = (await panMap(tx, actor.tenant.id)).get(pan);
  if (dup && dup !== employeeId) throw new AppError("conflict", "Someone else in the company already has this PAN. Check it and try again.", "pan");
  const enc = encryptField(pan, panScope(actor.tenant.id, employeeId));
  await tx`
    insert into employee_identities (tenant_id, employee_id, kind, number_enc, number_last4, name_on_doc)
    values (${actor.tenant.id}, ${employeeId}, 'pan', ${enc}, ${pan.slice(-4)}, ${p.display_name})
    on conflict (employee_id, kind) do update set number_enc = excluded.number_enc, number_last4 = excluded.number_last4, verified_at = null, updated_at = now()`;
  await audit(tx, actor, { entityType: "employee", entityId: employeeId, action: "pan.update", diff: { employeeId, last4: pan.slice(-4) } });
}

/** PAN → employee id for the whole company (decrypted in memory, for Form 16 matching). */
export async function panMap(tx: Tx, tenantId: string) {
  const rows = await tx<{ employee_id: string; number_enc: Uint8Array }[]>`select employee_id, number_enc from employee_identities where kind = 'pan'`;
  const out = new Map<string, string>();
  for (const r of rows) {
    try { out.set(decryptField(r.number_enc, panScope(tenantId, r.employee_id)), r.employee_id); } catch { /* unreadable with this key: skip */ }
  }
  return out;
}

// ---------------------------------------------------------------- declaration rows
type DeclRow = { id: string; regime: "old" | "new"; status: "draft" | "submitted" | "approved" | "locked"; house_property: unknown; other_income: unknown; previous_employer: unknown; submitted_at: Date | null };
type RawItem = { id: string; section: string; item: string; declared_paise: bigint; accepted_paise: bigint | null; proof_status: ItemRow["proofStatus"]; proof_file_ids: string[]; reviewer_comment: string | null; reviewed_at: Date | null };

async function declarationRow(tx: Tx, employeeId: string, fyStart: string) {
  const [d] = await tx<DeclRow[]>`select id, regime, status, house_property, other_income, previous_employer, submitted_at from tax_declarations where employee_id = ${employeeId} and fy_start = ${fyStart}`;
  return d ?? null;
}
async function itemsOf(tx: Tx, declarationId: string | null) {
  if (!declarationId) return [] as RawItem[];
  return tx<RawItem[]>`select id, section, item, declared_paise, accepted_paise, proof_status, proof_file_ids, reviewer_comment, reviewed_at from tax_declaration_items where declaration_id = ${declarationId} order by section, created_at`;
}
const toItem = (r: RawItem): ItemRow => ({ section: r.section, item: r.item, declaredPaise: N(r.declared_paise), acceptedPaise: r.accepted_paise == null ? null : N(r.accepted_paise), proofStatus: r.proof_status });

async function ensureDeclaration(tx: Tx, actor: Actor, p: Person, fyStart: string) {
  const cur = await declarationRow(tx, p.id, fyStart);
  if (cur) return cur;
  const regime = (await getStatutoryProfile(tx, p.id)).taxRegime;
  await tx`insert into tax_declarations (tenant_id, employee_id, fy_start, regime) values (${actor.tenant.id}, ${p.id}, ${fyStart}, ${regime}) on conflict (employee_id, fy_start) do nothing`;
  return (await declarationRow(tx, p.id, fyStart))!;
}

/** Self-service only, inside the declaration window. Returns the person and their declaration. */
async function editable(tx: Tx, actor: Actor, fyStart: string, today = todayIn()) {
  assertFy(fyStart);
  const p = await person(tx, actor.employeeId);
  if (p.status === "relieved") throw new AppError("forbidden", "You've left the company, so declarations can't change.");
  const w = declarationWindow(await settingsFor(tx, p.pay_group_id), fyStart, today, p.joining_date);
  if (!w.open) throw new AppError("invalid", w.message);
  return { p, d: await ensureDeclaration(tx, actor, p, fyStart) };
}

const VERIFIED = new Set(["accepted", "partially_accepted"]);

// ---------------------------------------------------------------- the year's numbers
type Projection = ReturnType<typeof projectSalary> & { hasSalary: boolean };

async function projectionFor(tx: Tx, p: Person, fyStart: string): Promise<Projection> {
  const comps = (await tx<{ code: string; kind: string; is_taxable: boolean }[]>`select code, kind, is_taxable from salary_components`).map((c) => ({ code: c.code, kind: c.kind, taxable: c.is_taxable }));
  const months = [];
  let has = false;
  for (const m of fyMonths(fyStart)) {
    const { days, ofDays } = daysEmployed(m, p.joining_date, p.exit_date);
    const on = p.joining_date > m ? p.joining_date : m;
    const s = days > 0 ? await getActiveSalary(tx, p.id, on) : null;
    if (s) has = true;
    months.push({ month: m, breakup: s?.breakup ?? null, days, ofDays });
  }
  return { ...projectSalary(months, comps), hasSalary: has };
}

async function ptEstimate(tx: Tx, p: Person, fyStart: string, proj: Projection) {
  try {
    const st = await getStatutoryProfile(tx, p.id);
    if (!st.ptState) return 0;
    const rates = await loadRates(tx, fyStart, st.ptState);
    if (!rates.pt) return 0;
    let ytd = 0;
    for (const m of proj.months) {
      if (!m.taxablePaise) continue;
      ytd += professionalTax({ config: rates.pt.config, month: Number(m.month.slice(5, 7)), grossPaise: m.taxablePaise, ytdPaise: ytd }).amountPaise;
    }
    return ytd;
  } catch { return 0; }
}

type Computed = {
  projection: Projection; hraExemptPaise: number; rentPaidPaise: number; totals: SectionTotals; deductions: TaxDeductions;
  grossIncomePaise: number; otherIncomePaise: number; previous: PreviousEmployer; other: OtherIncome; house: HouseProperty; final: boolean;
};

async function compute(tx: Tx, p: Person, fyStart: string, d: DeclRow | null, items: RawItem[], o: { asOf: string; withEstimates: boolean }): Promise<Computed> {
  const settings = await settingsFor(tx, p.pay_group_id);
  const final = proofsFinal(settings, fyStart, o.asOf);
  const limits = limitsFor(fyLabel(fyStart));
  const house = readHouse(d?.house_property), previous = d ? readPrevious(d.previous_employer) : EMPTY_PREVIOUS, other = d ? readOther(d.other_income) : EMPTY_OTHER;
  const rows = items.map(toItem);
  const totals = sectionTotals(rows, limits, final);
  const projection = await projectionFor(tx, p, fyStart);
  // HRA: rent counts month by month, scaled down if the proof for a rent period was only partly accepted
  const counted = new Map(items.filter((i) => i.section === "HRA").map((i) => [i.item, { counted: countedPaise(toItem(i), final), declared: N(i.declared_paise) }]));
  const scaled: RentPeriod[] = house.rent.map((r) => {
    const c = counted.get(r.id);
    if (!c || c.declared === 0) return { ...r, monthlyRentPaise: 0 };
    return c.counted === c.declared ? r : { ...r, monthlyRentPaise: Math.floor((r.monthlyRentPaise * c.counted) / c.declared) };
  });
  const rentMonths = rentByMonth(scaled, fyStart);
  const hra = hraExemption(projection.months.map((m, i) => ({ month: m.month, hraPaise: m.hraPaise, basicPaise: m.basicPaise, rentPaise: rentMonths[i].rentPaise, metro: rentMonths[i].metro })), limits);
  const pf = o.withEstimates && (await getStatutoryProfile(tx, p.id)).pfEnabled ? projection.pfEmployerPaise : 0;
  const pt = o.withEstimates ? await ptEstimate(tx, p, fyStart, projection) : 0;
  const deductions = toTaxDeductions(totals, hra.exemptPaise, { employeePfPaise: pf, professionalTaxPaise: pt });
  const otherIncomePaise = otherIncomeTotal(other);
  return {
    projection, hraExemptPaise: hra.exemptPaise, rentPaidPaise: totals.rentPaise, totals, deductions, final,
    grossIncomePaise: projection.taxablePaise + otherIncomePaise + previous.incomePaise, otherIncomePaise, previous, other, house,
  };
}

export type TaxInputs = {
  fyStart: string; fy: string;
  regime: "old" | "new"; regimeSource: "declaration" | "statutory_profile";
  status: "none" | "draft" | "submitted";
  /** after the proof cut-off: declared amounts nobody verified count as zero */
  proofsFinal: boolean;
  deductions: SectionTotals;
  bySection: { section: string; item: string; declaredPaise: number; countedPaise: number; proofStatus: ItemRow["proofStatus"] }[];
  hraExemptionPaise: number; rentPaidPaise: number;
  previousEmployer: PreviousEmployer;
  otherIncomePaise: number; otherIncome: OtherIncome;
  /** Ready for statutory projectTds()/annualTax(). Payroll adds the person's actual PF (80C) and PT itself. */
  taxDeductions: TaxDeductions;
  /** flexible benefit plan: what was declared for the year and the exemption it brings (old regime) */
  fbp: { declaredPaise: number; exemptPaise: number; status: "none" | "submitted" };
  limitsNote: string;
};

/**
 * What payroll's TDS projection needs from a person's declaration for the year starting `fyStart`.
 * Only a submitted declaration counts; before that (or with none) this returns the statutory profile's regime and nothing else.
 * Amounts are the accepted ones once a proof is verified, declared ones before that (zero for unverified items once the
 * proof window has closed). HRA exemption is worked out on the projected salary structure; payroll can redo it on actual
 * pay with hraExemption() from ./rules.
 */
export async function getTaxInputs(tx: Tx, employeeId: string, fyStart: string, opts: { asOf?: string } = {}): Promise<TaxInputs> {
  assertFy(fyStart);
  const p = await person(tx, employeeId);
  const d = await declarationRow(tx, employeeId, fyStart);
  const submitted = d && d.status !== "draft";
  const items = submitted ? await itemsOf(tx, d.id) : [];
  const c = await compute(tx, p, fyStart, submitted ? d : null, items, { asOf: opts.asOf ?? todayIn(), withEstimates: false });
  const regime = submitted ? d.regime : (await getStatutoryProfile(tx, employeeId)).taxRegime;
  const fbp = await fbpFor(tx, employeeId, fyStart);
  return {
    fyStart, fy: fyLabel(fyStart), regime, regimeSource: submitted ? "declaration" : "statutory_profile",
    fbp: { declaredPaise: fbp.declaredPaise, exemptPaise: fbp.exemptPaise, status: fbp.status },
    status: !d ? "none" : d.status === "draft" ? "draft" : "submitted",
    proofsFinal: c.final, deductions: c.totals,
    bySection: items.map((i) => ({ section: i.section, item: i.item, declaredPaise: N(i.declared_paise), countedPaise: countedPaise(toItem(i), c.final), proofStatus: i.proof_status })),
    hraExemptionPaise: c.hraExemptPaise, rentPaidPaise: c.rentPaidPaise,
    previousEmployer: c.previous, otherIncomePaise: c.otherIncomePaise, otherIncome: c.other,
    taxDeductions: { ...c.deductions, professionalTaxPaise: 0, otherExemptionsPaise: fbp.exemptPaise },
    limitsNote: limitsFor(fyLabel(fyStart)).sourceNote,
  };
}

// ---------------------------------------------------------------- the employee's page
export type TaxItemView = { id: string; section: string; item: string; label: string; declaredPaise: number; acceptedPaise: number | null; proofStatus: ItemRow["proofStatus"]; comment: string | null; proofs: { id: string; name: string }[]; locked: boolean };
export type Comparison = { old: AnnualTaxResult; new: AnnualTaxResult; better: "old" | "new"; savingPaise: number; grossIncomePaise: number; estimatesPaise: { pf: number; pt: number } } | null;

export async function myTax(tx: Tx, actor: Actor, fyStart: string, today = todayIn()) {
  assertFy(fyStart);
  const p = await person(tx, actor.employeeId);
  const d = await declarationRow(tx, p.id, fyStart);
  const raw = await itemsOf(tx, d?.id ?? null);
  const settings = await settingsFor(tx, p.pay_group_id);
  const c = await compute(tx, p, fyStart, d, raw, { asOf: today, withEstimates: true });
  const files = raw.flatMap((r) => r.proof_file_ids);
  const names = new Map((files.length ? await tx<{ id: string; name: string }[]>`select id, name from files where id = any(${files}::uuid[])` : []).map((f) => [f.id, f.name]));
  let comparison: Comparison = null, ratesError: string | null = null;
  try {
    const fy = fyLabel(fyStart);
    const [o, n] = await Promise.all([loadTaxRates(tx, fy, "old"), loadTaxRates(tx, fy, "new")]);
    const r = compareRegimes({ oldConfig: o.config, newConfig: n.config, grossIncomePaise: c.grossIncomePaise, deductions: c.deductions });
    comparison = { ...r, grossIncomePaise: c.grossIncomePaise, estimatesPaise: { pf: c.deductions.section80CPaise! - c.totals.section80CPaise, pt: c.deductions.professionalTaxPaise ?? 0 } };
  } catch (e) { ratesError = e instanceof AppError ? e.message : "Tax rates couldn't be loaded."; }
  const caps = await (async () => { try { const o = await loadTaxRates(tx, fyLabel(fyStart), "old"); return o.config.caps; } catch { return null; } })();
  const [f16] = await tx<{ part_a_file_id: string | null; name: string | null; part_b_file_id: string | null; name_b: string | null; published_at: Date | null }[]>`
    select d.part_a_file_id, f.name, d.part_b_file_id, fb.name as name_b, d.published_at from form16_documents d left join files f on f.id = d.part_a_file_id left join files fb on fb.id = d.part_b_file_id
    where d.employee_id = ${p.id} and d.fy_start = ${fyStart}`;
  const status = await verificationStatus(tx);
  return {
    fyStart, fy: fyLabel(fyStart), today, fyOptions: fyOptions(today, p.joining_date), name: p.display_name,
    declaration: { exists: !!d, regime: d?.regime ?? (await getStatutoryProfile(tx, p.id)).taxRegime, status: d?.status ?? "draft", submittedAt: d?.submitted_at?.toISOString() ?? null },
    window: declarationWindow(settings, fyStart, today, p.joining_date) as WindowState, proofWindow: proofWindow(settings, fyStart, today) as WindowState,
    items: raw.map((r): TaxItemView => ({
      id: r.id, section: r.section, item: r.item, label: itemLabel(r.section, r.item), declaredPaise: N(r.declared_paise), acceptedPaise: r.accepted_paise == null ? null : N(r.accepted_paise),
      proofStatus: r.proof_status, comment: r.reviewer_comment, proofs: r.proof_file_ids.map((id) => ({ id, name: names.get(id) ?? "Proof" })), locked: VERIFIED.has(r.proof_status),
    })),
    house: c.house, previous: c.previous, other: c.other,
    totals: c.totals, hraExemptPaise: c.hraExemptPaise, projection: { taxablePaise: c.projection.taxablePaise, hraPaise: c.projection.hraPaise, basicPaise: c.projection.basicPaise, hasSalary: c.projection.hasSalary },
    comparison, ratesError, caps, limits: limitsFor(fyLabel(fyStart)), pan: await panFor(tx, p.id),
    form16: f16 && f16.published_at && (f16.part_a_file_id || f16.part_b_file_id) ? {
      fileId: f16.part_a_file_id, name: f16.name ?? "Form 16 Part A.pdf", partBFileId: f16.part_b_file_id, partBName: f16.name_b ?? "Form 16 Part B.pdf", publishedAt: f16.published_at.toISOString(),
    } : null,
    rates: { verified: status.verified, stale: status.stale, latest: status.latest ? { verified_by_name: status.latest.verified_by_name, verified_on: status.latest.verified_on } : null },
  };
}
export type MyTax = Awaited<ReturnType<typeof myTax>>;

// ---------------------------------------------------------------- saving a declaration
export async function saveRegime(tx: Tx, actor: Actor, fyStart: string, regime: "old" | "new") {
  if (regime !== "old" && regime !== "new") throw bad("Pick a tax regime.");
  const { d } = await editable(tx, actor, fyStart);
  if (d.regime === regime) return { changed: false };
  await tx`update tax_declarations set regime = ${regime} where id = ${d.id}`;
  await audit(tx, actor, { entityType: "tax_declaration", entityId: d.id, action: "tax.regime", diff: { fyStart, regime } });
  return { changed: true };
}

const amount = z.number().int("Amounts are in whole paise").min(0, "Amounts can't be negative").max(1_00_00_000_00, "That amount is too large");
const sectionInput = z.array(z.object({ item: z.string(), declaredPaise: amount })).max(20);

/** Upsert one item; refuses to change an item whose proof was accepted. Zero removes an unverified item. Returns removed file keys. */
async function putItem(tx: Tx, actor: Actor, declId: string, section: string, item: string, declaredPaise: number): Promise<string[]> {
  const [cur] = await tx<RawItem[]>`select id, section, item, declared_paise, accepted_paise, proof_status, proof_file_ids, reviewer_comment, reviewed_at from tax_declaration_items where declaration_id = ${declId} and section = ${section} and item = ${item}`;
  if (cur && N(cur.declared_paise) === declaredPaise) return [];
  if (cur && VERIFIED.has(cur.proof_status)) throw bad(`Your proof for “${itemLabel(section, item)}” has been verified, so its amount can't change. Ask your payroll team.`);
  if (!cur && declaredPaise === 0) return [];
  if (cur && declaredPaise === 0) {
    await tx`delete from tax_declaration_items where id = ${cur.id}`;
    return dropFiles(tx, cur.proof_file_ids);
  }
  if (cur) {
    // a changed amount needs its proof checked again
    await tx`update tax_declaration_items set declared_paise = ${declaredPaise}, accepted_paise = null, reviewer_comment = null, reviewed_by = null, reviewed_at = null,
               proof_status = case when cardinality(proof_file_ids) > 0 then 'submitted' else 'not_submitted' end where id = ${cur.id}`;
  } else {
    await tx`insert into tax_declaration_items (tenant_id, declaration_id, section, item, declared_paise) values (${actor.tenant.id}, ${declId}, ${section}, ${item}, ${declaredPaise})`;
  }
  return [];
}

/** Save the amounts for one Chapter VI-A section (80C, 80D, 80CCD(1B), 80E). Items left out are untouched. */
export async function saveSection(tx: Tx, actor: Actor, fyStart: string, section: string, raw: unknown) {
  if (!(section in ITEMS)) throw bad("Pick a section.");
  const p = sectionInput.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0].message);
  for (const i of p.data) if (!isKnownItem(section, i.item)) throw bad("One of these items isn't part of this section.");
  if (section === "80D") {
    const has = (k: string) => p.data.some((i) => i.item === k && i.declaredPaise > 0);
    if (has("self_family") && has("self_family_senior")) throw bad("Fill in either the regular or the senior line for your family, not both.");
    if (has("parents") && has("parents_senior")) throw bad("Fill in either the regular or the senior line for your parents, not both.");
  }
  const { d } = await editable(tx, actor, fyStart);
  const removed: string[] = [];
  for (const i of p.data) removed.push(...(await putItem(tx, actor, d.id, section, i.item, i.declaredPaise)));
  await audit(tx, actor, { entityType: "tax_declaration", entityId: d.id, action: "tax.declare", diff: { fyStart, section, items: p.data } });
  return { removedKeys: removed };
}

const panOpt = z.string().trim().transform((s) => normalisePan(s)).nullable().optional().transform((s) => s || null)
  .refine((s) => s === null || isPan(s), "A PAN has 10 characters: 5 letters, 4 digits and a letter.");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/, "Pick a month.");
const rentInput = z.array(z.object({
  id: z.string().regex(/^rent_[a-z0-9]{1,12}$/).optional(),
  fromMonth: month, toMonth: month,
  monthlyRentPaise: z.number().int().positive("Enter the monthly rent.").max(1_00_00_000_00),
  landlordName: z.string().trim().min(2, "Enter the landlord's name.").max(200),
  landlordPan: panOpt,
  landlordAddress: z.string().trim().min(5, "Enter the rented home's address.").max(300),
  city: z.string().trim().min(2, "Enter the city.").max(80),
  metro: z.boolean(),
})).max(6, "Add at most 6 rent periods.");

/** Rent periods for HRA. Each period is one proof item (declared = rent for the months inside the year). */
export async function saveRent(tx: Tx, actor: Actor, fyStart: string, raw: unknown) {
  const p = rentInput.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0].message, String(p.error.issues[0].path.at(-1) ?? ""));
  const periods: RentPeriod[] = p.data.map((r) => ({ ...r, id: r.id ?? `rent_${randomBytes(4).toString("hex")}`, landlordPan: r.landlordPan ?? null }));
  const limits = limitsFor(fyLabel(fyStart));
  const problems = checkRentPeriods(periods, fyStart, limits);
  if (problems.length) throw bad(problems[0]);
  const { d } = await editable(tx, actor, fyStart);
  const house = readHouse(d.house_property);
  const removed: string[] = [];
  const keep = new Set(periods.map((r) => r.id));
  for (const old of house.rent) if (!keep.has(old.id)) removed.push(...(await putItem(tx, actor, d.id, "HRA", old.id, 0)));
  for (const r of periods) removed.push(...(await putItem(tx, actor, d.id, "HRA", r.id, annualRent([r], fyStart))));
  await tx`update tax_declarations set house_property = ${tx.json({ ...house, rent: periods } as never)} where id = ${d.id}`;
  await audit(tx, actor, { entityType: "tax_declaration", entityId: d.id, action: "tax.rent", diff: { fyStart, periods: periods.length, annualRentPaise: annualRent(periods, fyStart) } });
  return { removedKeys: removed };
}

const homeLoanInput = z.object({
  interestPaise: amount,
  lenderName: z.string().trim().max(200),
  lenderPan: panOpt,
  lenderAddress: z.string().trim().max(300),
  propertyAddress: z.string().trim().max(300),
});

/** Interest on a home loan for a self-occupied home (section 24(b)). Zero interest removes it. */
export async function saveHomeLoan(tx: Tx, actor: Actor, fyStart: string, raw: unknown) {
  const p = homeLoanInput.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  if (v.interestPaise > 0 && v.lenderName.length < 2) throw bad("Enter the lender's name.", "lenderName");
  if (v.interestPaise > 0 && v.propertyAddress.length < 5) throw bad("Enter the property's address.", "propertyAddress");
  const { d } = await editable(tx, actor, fyStart);
  const house = readHouse(d.house_property);
  const removed = await putItem(tx, actor, d.id, "24B", HOME_LOAN_ITEM, v.interestPaise);
  const homeLoan = v.interestPaise > 0 ? { lenderName: v.lenderName, lenderPan: v.lenderPan ?? null, lenderAddress: v.lenderAddress, propertyAddress: v.propertyAddress, selfOccupied: true } : null;
  await tx`update tax_declarations set house_property = ${tx.json({ ...house, homeLoan } as never)} where id = ${d.id}`;
  await audit(tx, actor, { entityType: "tax_declaration", entityId: d.id, action: "tax.home_loan", diff: { fyStart, interestPaise: v.interestPaise } });
  return { removedKeys: removed };
}

const previousInput = z.object({
  employerName: z.string().trim().max(200), tan: z.string().trim().toUpperCase().max(10).nullable().optional(),
  incomePaise: amount, tdsPaise: amount, pfPaise: amount, ptPaise: amount,
});
export async function savePreviousEmployer(tx: Tx, actor: Actor, fyStart: string, raw: unknown) {
  const p = previousInput.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  if (v.incomePaise > 0 && v.employerName.length < 2) throw bad("Enter your previous employer's name.", "employerName");
  if (v.tan && !/^[A-Z]{4}\d{5}[A-Z]$/.test(v.tan)) throw bad("A TAN has 10 characters: 4 letters, 5 digits and a letter.", "tan");
  if (v.tdsPaise > v.incomePaise) throw bad("Tax deducted can't be more than the income.", "tdsPaise");
  const { p: me, d } = await editable(tx, actor, fyStart);
  if (v.incomePaise > 0 && me.joining_date <= fyStart) throw bad(`You joined before FY ${fyLabel(fyStart)} started, so there's no previous employer income to declare for it.`, "incomePaise");
  const val: PreviousEmployer = { employerName: v.employerName, tan: v.tan || null, incomePaise: v.incomePaise, tdsPaise: v.tdsPaise, pfPaise: v.pfPaise, ptPaise: v.ptPaise };
  await tx`update tax_declarations set previous_employer = ${tx.json(val as never)} where id = ${d.id}`;
  await audit(tx, actor, { entityType: "tax_declaration", entityId: d.id, action: "tax.previous_employer", diff: { fyStart, incomePaise: v.incomePaise, tdsPaise: v.tdsPaise } });
}

const otherInput = z.object({ savingsInterestPaise: amount, depositInterestPaise: amount, otherPaise: amount, otherDescription: z.string().trim().max(300) });
export async function saveOtherIncome(tx: Tx, actor: Actor, fyStart: string, raw: unknown) {
  const p = otherInput.safeParse(raw);
  if (!p.success) throw bad(p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  if (p.data.otherPaise > 0 && p.data.otherDescription.length < 3) throw bad("Say what the other income is.", "otherDescription");
  const { d } = await editable(tx, actor, fyStart);
  await tx`update tax_declarations set other_income = ${tx.json(p.data as never)} where id = ${d.id}`;
  await audit(tx, actor, { entityType: "tax_declaration", entityId: d.id, action: "tax.other_income", diff: { fyStart, totalPaise: otherIncomeTotal(p.data) } });
}

/** Send the declaration to payroll. Until then payroll uses the default regime and no deductions. Idempotent. */
export async function submitDeclaration(tx: Tx, actor: Actor, fyStart: string) {
  const { d } = await editable(tx, actor, fyStart);
  const house = readHouse(d.house_property);
  const problems = checkRentPeriods(house.rent, fyStart, limitsFor(fyLabel(fyStart)));
  if (problems.length) throw bad(problems[0]);
  const items = await itemsOf(tx, d.id);
  const [r] = await tx<{ id: string }[]>`update tax_declarations set status = 'submitted', submitted_at = coalesce(submitted_at, now()) where id = ${d.id} and status = 'draft' returning id`;
  if (r) await audit(tx, actor, { entityType: "tax_declaration", entityId: d.id, action: "tax.submit", diff: { fyStart, regime: d.regime, items: items.length } });
  return { alreadySubmitted: !r };
}

// ---------------------------------------------------------------- proofs
export type Upload = { name: string; bytes: Uint8Array };
const PROOF_EXTS = new Set(["pdf", "png", "jpg", "jpeg"]);
export const MAX_PROOFS = 5;
const extOf = (n: string) => (n.includes(".") ? n.split(".").pop()!.toLowerCase() : "");

/** Deletes file rows no declaration item refers to any more; returns storage keys so the caller removes the bytes after commit. */
async function dropFiles(tx: Tx, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx<{ storage_key: string }[]>`
    delete from files f where f.id = any(${ids}::uuid[]) and not exists (select 1 from tax_declaration_items x where f.id = any(x.proof_file_ids)) returning storage_key`;
  return rows.map((r) => r.storage_key);
}

async function ownItem(tx: Tx, actor: Actor, itemId: string) {
  const [i] = await tx<(RawItem & { employee_id: string; fy_start: string; declaration_id: string })[]>`
    select i.id, i.section, i.item, i.declared_paise, i.accepted_paise, i.proof_status, i.proof_file_ids, i.reviewer_comment, i.reviewed_at, d.employee_id, d.fy_start::text, i.declaration_id
    from tax_declaration_items i join tax_declarations d on d.id = i.declaration_id where i.id = ${itemId}`;
  if (!i || i.employee_id !== actor.employeeId) throw new AppError("not_found", "Declaration item not found.");
  return i;
}

async function assertProofWindow(tx: Tx, actor: Actor, fyStart: string, today = todayIn()) {
  const p = await person(tx, actor.employeeId);
  const w = proofWindow(await settingsFor(tx, p.pay_group_id), fyStart, today);
  if (!w.open) throw new AppError("invalid", w.message);
}

/** Attach proof files to one of your items; the item goes (back) to the verification queue. */
export async function uploadProofs(tx: Tx, actor: Actor, itemId: string, files: Upload[]) {
  const i = await ownItem(tx, actor, itemId);
  await assertProofWindow(tx, actor, i.fy_start);
  if (VERIFIED.has(i.proof_status)) throw bad("This proof has already been verified.");
  if (!files.length) throw bad("Pick a file to upload.", "files");
  if (i.proof_file_ids.length + files.length > MAX_PROOFS) throw bad(`Attach up to ${MAX_PROOFS} files per item.`, "files");
  const ids: string[] = [];
  for (const f of files) {
    if (!PROOF_EXTS.has(extOf(f.name))) throw bad("Proofs must be PDF, PNG or JPG files of up to 5 MB.", "files");
    const v = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
    if (!v.ok) throw bad(v.error, "files");
    ids.push(await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: v.name, mime: v.mime, bytes: f.bytes, ext: extOf(v.name) }));
  }
  await tx`update tax_declaration_items set proof_file_ids = proof_file_ids || ${ids}::uuid[], proof_status = 'submitted', accepted_paise = null, reviewed_by = null, reviewed_at = null where id = ${i.id}`;
  await audit(tx, actor, { entityType: "tax_declaration_item", entityId: i.id, action: "tax.proof_upload", diff: { section: i.section, item: i.item, files: ids.length } });
  return { fileIds: ids };
}

export async function removeProof(tx: Tx, actor: Actor, itemId: string, fileId: string) {
  const i = await ownItem(tx, actor, itemId);
  if (VERIFIED.has(i.proof_status)) throw bad("This proof has already been verified, so it can't be removed.");
  if (!i.proof_file_ids.includes(fileId)) throw new AppError("not_found", "File not found.");
  const left = i.proof_file_ids.filter((f) => f !== fileId);
  await tx`update tax_declaration_items set proof_file_ids = ${left}::uuid[], proof_status = ${left.length ? (i.proof_status === "rejected" ? "rejected" : "submitted") : "not_submitted"} where id = ${i.id}`;
  return { removedKeys: await dropFiles(tx, [fileId]) };
}

// ---------------------------------------------------------------- payroll: proof verification
export type ProofRow = {
  id: string; employeeId: string; employee: string; employeeNumber: string | null; section: string; item: string; label: string; fyStart: string;
  declaredPaise: number; acceptedPaise: number | null; proofStatus: ItemRow["proofStatus"]; comment: string | null; files: { id: string; name: string }[];
  submittedAt: string; mine: boolean; canVerify: boolean; detail: string | null;
};

/** Items with proofs for the year, for people this payroll admin covers. Your own items show, but you can't verify them. */
export async function proofQueue(tx: Tx, actor: Actor, fyStart: string, status: "submitted" | "reviewed" | "all" = "submitted"): Promise<ProofRow[]> {
  assertFy(fyStart);
  if (!hasAnyPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins can verify proofs.");
  const rows = await tx<(RawItem & Placement & { employee_id: string; display_name: string; employee_number: string | null; house_property: unknown; updated_at: Date })[]>`
    select i.id, i.section, i.item, i.declared_paise, i.accepted_paise, i.proof_status, i.proof_file_ids, i.reviewer_comment, i.reviewed_at, i.updated_at,
      e.id as employee_id, e.display_name, e.employee_number, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, d.house_property
    from tax_declaration_items i join tax_declarations d on d.id = i.declaration_id join employees e on e.id = d.employee_id
    where d.fy_start = ${fyStart} and cardinality(i.proof_file_ids) > 0
      and (${status} = 'all' or (${status} = 'submitted' and i.proof_status = 'submitted') or (${status} = 'reviewed' and i.proof_status in ('accepted','partially_accepted','rejected')))
    order by i.updated_at`;
  const visible = rows.filter((r) => canPayrollFor(actor, r));
  const ids = visible.flatMap((r) => r.proof_file_ids);
  const names = new Map((ids.length ? await tx<{ id: string; name: string }[]>`select id, name from files where id = any(${ids}::uuid[])` : []).map((f) => [f.id, f.name]));
  return visible.map((r) => {
    const rent = r.section === "HRA" ? readHouse(r.house_property).rent.find((x) => x.id === r.item) : null;
    const hl = r.section === "24B" ? readHouse(r.house_property).homeLoan : null;
    return {
      id: r.id, employeeId: r.employee_id, employee: r.display_name, employeeNumber: r.employee_number, section: r.section, item: r.item, label: itemLabel(r.section, r.item), fyStart,
      declaredPaise: N(r.declared_paise), acceptedPaise: r.accepted_paise == null ? null : N(r.accepted_paise), proofStatus: r.proof_status, comment: r.reviewer_comment,
      files: r.proof_file_ids.map((id) => ({ id, name: names.get(id) ?? "Proof" })), submittedAt: r.updated_at.toISOString(),
      mine: r.employee_id === actor.employeeId, canVerify: r.employee_id !== actor.employeeId && r.proof_status === "submitted",
      detail: rent ? `${rent.landlordName}, ${rent.city}${rent.metro ? " (metro)" : ""} · ${rent.fromMonth.slice(0, 7)} to ${rent.toMonth.slice(0, 7)}${rent.landlordPan ? ` · PAN ${rent.landlordPan}` : ""}`
        : hl ? `${hl.lenderName}${hl.lenderPan ? ` · PAN ${hl.lenderPan}` : ""}` : null,
    };
  });
}

const verifyInput = z.object({
  decision: z.enum(["accept", "partial", "reject"]),
  acceptedPaise: z.number().int().min(0).optional(),
  comment: z.string().trim().max(1000).optional(),
});

/** Accept in full, accept part of the amount, or reject (with a comment). Never your own; guarded so a double click can't decide twice. */
export async function verifyProof(tx: Tx, actor: Actor, itemId: string, raw: unknown) {
  const p = verifyInput.safeParse(raw);
  if (!p.success) throw bad("Pick a decision.");
  const v = p.data;
  const [i] = await tx<(RawItem & Placement & { employee_id: string; fy_start: string })[]>`
    select i.id, i.section, i.item, i.declared_paise, i.accepted_paise, i.proof_status, i.proof_file_ids, i.reviewer_comment, i.reviewed_at, d.employee_id, d.fy_start::text,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
    from tax_declaration_items i join tax_declarations d on d.id = i.declaration_id join employees e on e.id = d.employee_id where i.id = ${itemId}`;
  if (!i || !canPayrollFor(actor, i)) throw new AppError("not_found", "Proof not found.");
  if (i.employee_id === actor.employeeId) throw new AppError("forbidden", "You can't verify your own proofs. Another payroll admin has to.");
  const declared = N(i.declared_paise);
  let accepted: number, status: ItemRow["proofStatus"];
  const comment = v.comment || null;
  if (v.decision === "accept") { accepted = declared; status = "accepted"; }
  else if (v.decision === "reject") {
    if (!comment) throw bad("Say why the proof is rejected, so they can fix it.", "comment");
    accepted = 0; status = "rejected";
  } else {
    if (v.acceptedPaise == null || v.acceptedPaise <= 0 || v.acceptedPaise >= declared) throw bad("A partial acceptance is more than ₹0 and less than the declared amount.", "acceptedPaise");
    if (!comment) throw bad("Say why only part of the amount is accepted.", "comment");
    accepted = v.acceptedPaise; status = "partially_accepted";
  }
  const [r] = await tx<{ id: string }[]>`
    update tax_declaration_items set proof_status = ${status}, accepted_paise = ${accepted}, reviewer_comment = ${comment}, reviewed_by = ${actor.userId}, reviewed_at = now()
    where id = ${i.id} and proof_status = 'submitted' returning id`;
  if (!r) throw new AppError("conflict", "This proof was already checked, or was changed in the meantime.");
  await audit(tx, actor, { entityType: "tax_declaration_item", entityId: i.id, action: `tax.proof_${status}`, diff: { employeeId: i.employee_id, section: i.section, item: i.item, declaredPaise: declared, acceptedPaise: accepted, comment } });
  const label = itemLabel(i.section, i.item);
  await notifyEmployee(tx, actor.tenant.id, i.employee_id, "tax.proof",
    status === "accepted" ? "Your tax proof was accepted" : status === "rejected" ? "Your tax proof needs another look" : "Your tax proof was partly accepted",
    status === "rejected" ? `${label}: ${comment}` : `${label}: ${inr(accepted)} accepted.${comment ? " " + comment : ""}`,
    `/me/tax?fy=${fyLabel(i.fy_start)}&tab=proofs`);
  return { status, acceptedPaise: accepted };
}

// ---------------------------------------------------------------- payroll: everyone's declarations
export async function declarationsOverview(tx: Tx, actor: Actor, fyStart: string) {
  assertFy(fyStart);
  if (!hasAnyPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins can see declarations.");
  const rows = await tx<(Placement & { id: string; display_name: string; employee_number: string | null; regime: "old" | "new" | null; status: string | null; submitted_at: Date | null; declared: bigint | null; items: number; pending: number; pan: boolean })[]>`
    select e.id, e.display_name, e.employee_number, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      d.regime, d.status, d.submitted_at,
      (select sum(declared_paise) from tax_declaration_items i where i.declaration_id = d.id) as declared,
      (select count(*)::int from tax_declaration_items i where i.declaration_id = d.id) as items,
      (select count(*)::int from tax_declaration_items i where i.declaration_id = d.id and i.proof_status = 'submitted') as pending,
      exists (select 1 from employee_identities x where x.employee_id = e.id and x.kind = 'pan') as pan
    from employees e left join tax_declarations d on d.employee_id = e.id and d.fy_start = ${fyStart}
    where e.status <> 'relieved' and e.joining_date <= ${fyEnd(fyStart)} order by e.display_name`;
  return rows.filter((r) => canPayrollFor(actor, r)).map((r) => ({
    employeeId: r.id, name: r.display_name, employeeNumber: r.employee_number, regime: r.regime, status: (r.status ?? "none") as "none" | "draft" | "submitted" | "approved" | "locked",
    submittedAt: r.submitted_at?.toISOString() ?? null, declaredPaise: N(r.declared), items: r.items, pendingProofs: r.pending, hasPan: r.pan,
  }));
}

// ---------------------------------------------------------------- Form 16
/** People (in scope) with their Form 16 for the year. */
export async function form16List(tx: Tx, actor: Actor, fyStart: string) {
  assertFy(fyStart);
  if (!hasAnyPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins can manage Form 16.");
  const rows = await tx<(Placement & { id: string; display_name: string; employee_number: string | null; doc_id: string | null; file_id: string | null; file_name: string | null; part_b_id: string | null; part_b_name: string | null; published_at: Date | null; uploaded_at: Date | null; pan: string | null; paid_months: number })[]>`
    select e.id, e.display_name, e.employee_number, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      f.id as doc_id, f.part_a_file_id as file_id, fl.name as file_name, f.part_b_file_id as part_b_id, fb.name as part_b_name, f.published_at, f.updated_at as uploaded_at,
      (select number_last4 from employee_identities x where x.employee_id = e.id and x.kind = 'pan') as pan,
      (select count(*)::int from payroll_lines l join payroll_runs r on r.id = l.run_id where l.employee_id = e.id and r.status in ('finalized','payslips_released','paid') and r.period_month between ${fyStart} and ${fyEnd(fyStart)}) as paid_months
    from employees e left join form16_documents f on f.employee_id = e.id and f.fy_start = ${fyStart} left join files fl on fl.id = f.part_a_file_id left join files fb on fb.id = f.part_b_file_id
    where e.joining_date <= ${fyEnd(fyStart)} and (e.status <> 'relieved' or f.id is not null) order by e.display_name`;
  return rows.filter((r) => canPayrollFor(actor, r)).map((r) => ({
    employeeId: r.id, name: r.display_name, employeeNumber: r.employee_number, panLast4: r.pan, docId: r.doc_id,
    file: r.file_id ? { id: r.file_id, name: r.file_name ?? "Form 16.pdf" } : null, partB: r.part_b_id ? { id: r.part_b_id, name: r.part_b_name ?? "Form 16 Part B.pdf" } : null,
    publishedAt: r.published_at?.toISOString() ?? null, uploadedAt: r.uploaded_at?.toISOString() ?? null, paidMonths: r.paid_months,
  }));
}

export type Form16Report = { matched: { file: string; employee: string; replaced: boolean }[]; unmatched: { file: string; reason: string }[] };

/**
 * Upload Part A files: PDFs and/or ZIPs of PDFs, each named by the employee's PAN ("ABCDE1234F….pdf").
 * Matches across the whole company, so it needs payroll.admin without a scope. Re-uploading replaces the earlier file
 * (and un-publishes it until published again). Returns what matched and what didn't, plus storage keys to delete after commit.
 */
export async function uploadForm16(tx: Tx, actor: Actor, fyStart: string, uploads: Upload[]): Promise<Form16Report & { removedKeys: string[] }> {
  assertFy(fyStart);
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can upload Form 16.");
  if (!uploads.length) throw bad("Pick the ZIP or PDF files to upload.", "files");
  const pdfs: Upload[] = [];
  const report: Form16Report = { matched: [], unmatched: [] };
  for (const u of uploads) {
    if (extOf(u.name) === "zip") {
      try { pdfs.push(...readZip(u.bytes)); } catch (e) { if (e instanceof ZipError) throw bad(`${u.name}: ${e.message}`, "files"); throw e; }
    } else pdfs.push(u);
  }
  const pans = await panMap(tx, actor.tenant.id);
  const seen = new Set<string>();
  const removed: string[] = [];
  for (const f of pdfs) {
    const pan = panFromFileName(f.name);
    if (extOf(f.name) !== "pdf") { report.unmatched.push({ file: f.name, reason: "Not a PDF" }); continue; }
    if (!pan) { report.unmatched.push({ file: f.name, reason: "The file name doesn't start with a PAN" }); continue; }
    const employeeId = pans.get(pan);
    if (!employeeId) { report.unmatched.push({ file: f.name, reason: `No one in the company has PAN ending ${pan.slice(-4)}` }); continue; }
    if (seen.has(employeeId)) { report.unmatched.push({ file: f.name, reason: "Another file in this upload is for the same person" }); continue; }
    const v = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
    if (!v.ok) { report.unmatched.push({ file: f.name, reason: v.error }); continue; }
    seen.add(employeeId);
    const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: v.name, mime: v.mime, bytes: f.bytes, ext: "pdf" });
    const [prev] = await tx<{ part_a_file_id: string | null }[]>`select part_a_file_id from form16_documents where employee_id = ${employeeId} and fy_start = ${fyStart}`;
    await tx`
      insert into form16_documents (tenant_id, employee_id, fy_start, part_a_file_id) values (${actor.tenant.id}, ${employeeId}, ${fyStart}, ${fileId})
      on conflict (employee_id, fy_start) do update set part_a_file_id = excluded.part_a_file_id, published_at = null, published_by = null, updated_at = now()`;
    if (prev?.part_a_file_id) {
      const rows = await tx<{ storage_key: string }[]>`delete from files where id = ${prev.part_a_file_id} returning storage_key`;
      removed.push(...rows.map((r) => r.storage_key));
    }
    const [{ display_name }] = await tx<{ display_name: string }[]>`select display_name from employees where id = ${employeeId}`;
    report.matched.push({ file: f.name, employee: display_name, replaced: !!prev?.part_a_file_id });
  }
  await audit(tx, actor, { entityType: "form16", entityId: null, action: "form16.upload", diff: { fyStart, matched: report.matched.length, unmatched: report.unmatched.length } });
  return { ...report, removedKeys: removed };
}

/** Make uploaded Form 16s visible to their employees and tell them. Company-wide action. */
export async function publishForm16(tx: Tx, actor: Actor, fyStart: string, employeeIds: string[] | "all") {
  assertFy(fyStart);
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can publish Form 16.");
  const rows = employeeIds === "all"
    ? await tx<{ id: string; employee_id: string; part_a_file_id: string | null; part_b_file_id: string | null }[]>`update form16_documents set published_at = now(), published_by = ${actor.userId} where fy_start = ${fyStart} and (part_a_file_id is not null or part_b_file_id is not null) and published_at is null returning id, employee_id, part_a_file_id, part_b_file_id`
    : await tx<{ id: string; employee_id: string; part_a_file_id: string | null; part_b_file_id: string | null }[]>`update form16_documents set published_at = now(), published_by = ${actor.userId} where fy_start = ${fyStart} and (part_a_file_id is not null or part_b_file_id is not null) and published_at is null and employee_id = any(${employeeIds}::uuid[]) returning id, employee_id, part_a_file_id, part_b_file_id`;
  for (const r of rows) {
    const parts = [r.part_a_file_id ? "Part A" : null, r.part_b_file_id ? "Part B" : null].filter(Boolean).join(" and ");
    await notifyEmployee(tx, actor.tenant.id, r.employee_id, "tax.form16", "Your Form 16 is ready", `Form 16 ${parts} for FY ${fyLabel(fyStart)} ${r.part_a_file_id && r.part_b_file_id ? "are" : "is"} available to download.`, `/me/tax?fy=${fyLabel(fyStart)}&tab=forms`);
  }
  await audit(tx, actor, { entityType: "form16", entityId: null, action: "form16.publish", diff: { fyStart, count: rows.length } });
  return { published: rows.length };
}

export async function deleteForm16(tx: Tx, actor: Actor, docId: string) {
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can remove Form 16 files.");
  const [d] = await tx<{ part_a_file_id: string | null; part_b_file_id: string | null; employee_id: string }[]>`delete from form16_documents where id = ${docId} returning part_a_file_id, part_b_file_id, employee_id`;
  if (!d) throw new AppError("not_found", "Form 16 not found.");
  const ids = [d.part_a_file_id, d.part_b_file_id].filter((x): x is string => !!x);
  const keys = ids.length ? (await tx<{ storage_key: string }[]>`delete from files where id = any(${ids}::uuid[]) returning storage_key`).map((r) => r.storage_key) : [];
  await audit(tx, actor, { entityType: "form16", entityId: docId, action: "form16.delete", diff: { employeeId: d.employee_id } });
  return { removedKeys: keys };
}

// ---------------------------------------------------------------- file access
/** A proof or Form 16 file the actor may open (same "not found" for everything else). */
export async function taxFileFor(tx: Tx, actor: Actor, fileId: string) {
  const [f] = await tx<{ id: string; storage_key: string; name: string; mime: string }[]>`select id, storage_key, name, mime from files where id = ${fileId}`;
  if (!f) return null;
  const [proof] = await tx<{ employee_id: string }[]>`select d.employee_id from tax_declaration_items i join tax_declarations d on d.id = i.declaration_id where ${fileId}::uuid = any(i.proof_file_ids) limit 1`;
  const [form] = proof ? [] : await tx<{ employee_id: string; published_at: Date | null }[]>`select employee_id, published_at from form16_documents where part_a_file_id = ${fileId} or part_b_file_id = ${fileId} limit 1`;
  const owner = proof?.employee_id ?? form?.employee_id;
  if (!owner) return null;
  if (owner === actor.employeeId && (proof || form?.published_at)) return f;
  const p = await placementOf(tx, owner);
  return p && canPayrollFor(actor, p) ? f : null;
}

// ---------------------------------------------------------------- Form 12BB-style summary
export async function form12bbData(tx: Tx, actor: Actor, employeeId: string, fyStart: string) {
  assertFy(fyStart);
  const p = await person(tx, employeeId);
  if (employeeId !== actor.employeeId && !canPayrollFor(actor, p)) return null;
  const d = await declarationRow(tx, employeeId, fyStart);
  if (!d) return null;
  const items = await itemsOf(tx, d.id);
  const house = readHouse(d.house_property);
  const [company] = await tx<{ name: string }[]>`select name from tenants where id = app_tenant()`;
  const pan = await panFor(tx, employeeId);
  return {
    company: company?.name ?? "", name: p.display_name, employeeNumber: p.employee_number, designation: p.designation, panLast4: pan?.last4 ?? null,
    fy: fyLabel(fyStart), regime: d.regime, status: d.status, submittedAt: d.submitted_at?.toISOString() ?? null,
    rent: house.rent.map((r) => ({ ...r, annualPaise: annualRent([r], fyStart) })),
    homeLoan: house.homeLoan ? { ...house.homeLoan, interestPaise: N(items.find((i) => i.section === "24B")?.declared_paise) } : null,
    chapterVIA: items.filter((i) => i.section in ITEMS).map((i) => ({ section: i.section, label: itemLabel(i.section, i.item), declaredPaise: N(i.declared_paise), status: i.proof_status })),
    previous: readPrevious(d.previous_employer), other: readOther(d.other_income),
  };
}
export type Form12bbData = NonNullable<Awaited<ReturnType<typeof form12bbData>>>;
