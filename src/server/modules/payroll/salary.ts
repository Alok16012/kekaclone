import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { cancelApproval, notifyEmployee, startApproval, timeline } from "@/server/modules/approvals/service";
import { inr } from "@/server/modules/tax/rules";
import { onSalaryRevisionDecided } from "./effects";
import { markPersonRunsStale } from "@/server/modules/payrun/stale";
import { todayIn } from "@/lib/dates";
import { assertCanChangePay, canPayrollFor, placementOf } from "./access";
import { arrearsFromMonth, computeBreakup, INDIAN_STATES, isAccountNumber, isEsiNumber, isIfsc, isPfNumber, isStateCode, isUan, last4, MAX_CTC_PAISE, normaliseAccount, normaliseIfsc, REVISION_REASONS, type ComponentKind } from "./rules";
import { decryptField, encryptField } from "./secret";
import { listStructures, toDef, type StructureRow } from "./setup";

export type ActiveSalary = {
  id: string; employeeId: string; structureId: string; structureName: string; payGroupId: string;
  ctcPaise: number; currency: string; effectiveFrom: string; reason: "joining" | "revision" | "promotion" | "correction";
  arrearsFromMonth: string | null; breakup: Record<string, number>;
};

const salaryCols = (tx: Tx) => tx`
  s.id, s.employee_id, s.structure_id, st.name as structure_name, st.pay_group_id, s.ctc_paise, s.currency, s.effective_from::text, s.reason,
  s.arrears_from_month::text, s.breakup, s.status, s.created_at`;
type SalaryRow = { id: string; employee_id: string; structure_id: string; structure_name: string; pay_group_id: string; ctc_paise: bigint; currency: string; effective_from: string; reason: ActiveSalary["reason"]; arrears_from_month: string | null; breakup: Record<string, number>; status: string; created_at: Date };
const toSalary = (r: SalaryRow): ActiveSalary => ({
  id: r.id, employeeId: r.employee_id, structureId: r.structure_id, structureName: r.structure_name, payGroupId: r.pay_group_id,
  ctcPaise: Number(r.ctc_paise), currency: r.currency, effectiveFrom: r.effective_from, reason: r.reason, arrearsFromMonth: r.arrears_from_month, breakup: r.breakup,
});

/** The salary in force on `date` (the latest approved revision that starts on or before it), or null. For payroll. */
export async function getActiveSalary(tx: Tx, employeeId: string, date: string): Promise<ActiveSalary | null> {
  const [r] = await tx<SalaryRow[]>`
    select ${salaryCols(tx)} from employee_salaries s join salary_structures st on st.id = s.structure_id
    where s.employee_id = ${employeeId} and s.status in ('active','superseded') and s.effective_from <= ${date}
    order by s.effective_from desc limit 1`;
  return r ? toSalary(r) : null;
}

export type StatutoryProfile = {
  pfEnabled: boolean; uan: string | null; pfNumber: string | null; pfOnFullWage: boolean;
  esiEnabled: boolean; esiNumber: string | null;
  /** effective PT state: the person's own override, else their work location's state */
  ptState: string | null; ptStateSource: "profile" | "location" | null; ptStateOverride: string | null; locationState: string | null;
  lwfState: string | null; taxRegime: "old" | "new";
};

/** PF / ESI / PT / LWF / tax regime settings for payroll. Defaults (PF and ESI on, new regime) when nothing is recorded. */
export async function getStatutoryProfile(tx: Tx, employeeId: string): Promise<StatutoryProfile> {
  const [r] = await tx<{ pf_enabled: boolean | null; uan: string | null; pf_number: string | null; pf_on_full_wage: boolean | null; esi_enabled: boolean | null; esi_number: string | null; pt_state: string | null; lwf_state: string | null; tax_regime: "old" | "new" | null; location_state: string | null }[]>`
    select st.pf_enabled, st.uan, st.pf_number, st.pf_on_full_wage, st.esi_enabled, st.esi_number, st.pt_state, st.lwf_state, st.tax_regime, l.state_code as location_state
    from employees e left join employee_statutory st on st.employee_id = e.id left join locations l on l.id = e.location_id
    where e.id = ${employeeId}`;
  if (!r) throw new AppError("not_found", "Person not found.");
  const pt = r.pt_state ?? r.location_state ?? null;
  return {
    pfEnabled: r.pf_enabled ?? true, uan: r.uan, pfNumber: r.pf_number, pfOnFullWage: r.pf_on_full_wage ?? false,
    esiEnabled: r.esi_enabled ?? true, esiNumber: r.esi_number,
    ptState: pt, ptStateSource: r.pt_state ? "profile" : r.location_state ? "location" : null, ptStateOverride: r.pt_state, locationState: r.location_state,
    lwfState: r.lwf_state ?? r.location_state ?? null, taxRegime: r.tax_regime ?? "new",
  };
}

/** Months whose payroll is already finalised for this person's pay group (first-of-month dates). */
async function lockedMonths(tx: Tx, payGroupId: string) {
  const rows = await tx<{ m: string }[]>`select period_month::text as m from payroll_runs where pay_group_id = ${payGroupId} and status in ('finalized','payslips_released','paid')`;
  return rows.map((r) => r.m);
}

/** After any change: the newest revision is 'active', older approved ones 'superseded'. */
async function restatus(tx: Tx, employeeId: string) {
  await tx`
    update employee_salaries s set status = case when s.id = x.latest then 'active' else 'superseded' end, updated_at = now()
    from (select id as latest from employee_salaries where employee_id = ${employeeId} and status in ('active','superseded') order by effective_from desc limit 1) x
    where s.employee_id = ${employeeId} and s.status in ('active','superseded') and s.status <> case when s.id = x.latest then 'active' else 'superseded' end`;
}

export const salaryInput = z.object({
  employeeId: z.uuid(),
  structureId: z.uuid("Pick a salary structure"),
  ctcPaise: z.number().int("CTC must be in whole paise").positive("Enter the annual CTC").max(MAX_CTC_PAISE, "That CTC is larger than erp supports"),
  effectiveFrom: z.iso.date("Pick the date it takes effect"),
  reason: z.enum(["joining", ...REVISION_REASONS]).optional(),
});
export type SalaryInput = z.infer<typeof salaryInput>;

/**
 * Assign a first salary or record a revision. Effective-dated (one per start date per person); future dates are fine,
 * and a date reaching back into an already-paid month records `arrears_from_month` for payroll to settle.
 * Idempotent: the exact same CTC and structure on the same date returns the existing row.
 */
export async function saveSalary(tx: Tx, actor: Actor, raw: unknown, opts: { today?: string; notify?: boolean; approval?: boolean } = {}) {
  const p = salaryInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const today = opts.today ?? todayIn();
  await assertCanChangePay(tx, actor, v.employeeId);
  const [emp] = await tx<{ status: string; joining_date: string; pay_group_id: string | null; legal_entity_id: string | null; display_name: string; exit_date: string | null }[]>`
    select status, joining_date::text, pay_group_id, legal_entity_id, display_name, exit_date::text from employees where id = ${v.employeeId}`;
  if (emp.status === "relieved") throw new AppError("invalid", `${emp.display_name} has left the company.`);
  if (v.effectiveFrom < emp.joining_date) throw new AppError("invalid", `The salary can't start before ${emp.display_name} joined (${emp.joining_date}).`, "effectiveFrom");
  if (emp.exit_date && v.effectiveFrom > emp.exit_date) throw new AppError("invalid", `${emp.display_name}'s last day is ${emp.exit_date}; the salary must start before that.`, "effectiveFrom");
  const [st] = await tx<{ id: string; pay_group_id: string; legal_entity_id: string; pay_group: string }[]>`
    select s.id, s.pay_group_id, g.legal_entity_id, g.name as pay_group from salary_structures s join pay_groups g on g.id = s.pay_group_id where s.id = ${v.structureId}`;
  if (!st) throw new AppError("invalid", "Pick a salary structure.", "structureId");
  if (emp.pay_group_id && emp.pay_group_id !== st.pay_group_id) throw new AppError("invalid", `${emp.display_name} is in another pay group. Pick a structure from their pay group, or move them to ${st.pay_group} first.`, "structureId");
  if (!emp.pay_group_id && emp.legal_entity_id && emp.legal_entity_id !== st.legal_entity_id) throw new AppError("invalid", `${st.pay_group} belongs to a different legal entity than ${emp.display_name}.`, "structureId");

  const [existing] = await tx<{ id: string; ctc_paise: bigint; structure_id: string; status: string }[]>`select id, ctc_paise, structure_id, status from employee_salaries where employee_id = ${v.employeeId} and effective_from = ${v.effectiveFrom}`;
  if (existing) {
    if (Number(existing.ctc_paise) === v.ctcPaise && existing.structure_id === v.structureId) return { id: existing.id, unchanged: true, arrearsFromMonth: null as string | null, pendingApproval: existing.status === "pending_approval" };
    if (existing.status === "pending_approval") throw new AppError("conflict", "A revision starting on this date is waiting for approval. Decide that one first, or pick another date.", "effectiveFrom");
    throw new AppError("conflict", "A salary already starts on this date. Delete it first, or pick another date.", "effectiveFrom");
  }
  const [{ n: prior }] = await tx<{ n: number }[]>`select count(*)::int as n from employee_salaries where employee_id = ${v.employeeId} and status in ('active','superseded')`;
  const [earlier] = await tx`select 1 from employee_salaries where employee_id = ${v.employeeId} and status in ('active','superseded') and effective_from < ${v.effectiveFrom} limit 1`;
  const reason = !earlier ? "joining" : v.reason && v.reason !== "joining" ? v.reason : "revision";
  if (prior && !earlier) throw new AppError("invalid", "This would start before their first salary. Pick a date after it, or delete the first salary.", "effectiveFrom");

  const lines = (await listStructures(tx)).find((s) => s.id === v.structureId)!.lines;
  const b = computeBreakup(toDef(lines), v.ctcPaise);
  if (!b.ok) throw new AppError("invalid", b.errors[0].message, "ctcPaise");
  const arrears = arrearsFromMonth(v.effectiveFrom, today, await lockedMonths(tx, st.pay_group_id));
  // revisions go through approval when the company has an approval workflow for them (Settings → Approvals); a first salary never does
  const needsApproval = reason !== "joining" && opts.approval !== false && await revisionsNeedApproval(tx);

  const [row] = await tx<{ id: string }[]>`
    insert into employee_salaries (tenant_id, employee_id, structure_id, ctc_paise, effective_from, breakup, reason, arrears_from_month, status, created_by)
    values (${actor.tenant.id}, ${v.employeeId}, ${v.structureId}, ${v.ctcPaise}, ${v.effectiveFrom}, ${tx.json(b.breakup)}, ${reason}, ${arrears}, ${needsApproval ? "pending_approval" : "superseded"}, ${actor.userId})
    returning id`;
  if (needsApproval) {
    await audit(tx, actor, { entityType: "employee_salary", entityId: row.id, action: "salary.revision_requested", diff: { employeeId: v.employeeId, ctcPaise: v.ctcPaise, structureId: v.structureId, effectiveFrom: v.effectiveFrom, reason, arrearsFromMonth: arrears } });
    const r = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "salary_revision", entityId: row.id, requesterId: actor.employeeId,
      summary: `${actor.name} · Salary ${reason} · ${emp.display_name} · ${inr(v.ctcPaise)} a year from ${v.effectiveFrom}` });
    if (r.status === "approved") { await onSalaryRevisionDecided(tx, actor, row.id, "approved"); return { id: row.id, unchanged: false, arrearsFromMonth: arrears, pendingApproval: false }; }
    return { id: row.id, unchanged: false, arrearsFromMonth: arrears, pendingApproval: true };
  }
  await restatus(tx, v.employeeId);
  if (!emp.pay_group_id) await tx`update employees set pay_group_id = ${st.pay_group_id}, updated_at = now() where id = ${v.employeeId}`;
  await markPersonRunsStale(tx, v.employeeId, arrears ?? v.effectiveFrom);   // an open run already calculated must pick the new salary up
  await audit(tx, actor, { entityType: "employee_salary", entityId: row.id, action: reason === "joining" ? "salary.assign" : "salary.revise",
    diff: { employeeId: v.employeeId, ctcPaise: v.ctcPaise, structureId: v.structureId, effectiveFrom: v.effectiveFrom, reason, arrearsFromMonth: arrears } });
  if (opts.notify !== false) {
    await notifyEmployee(tx, actor.tenant.id, v.employeeId, "salary.updated", reason === "joining" ? "Your salary has been set up" : "Your salary has been revised",
      `Effective ${v.effectiveFrom}. See the breakup on the Finances tab of your profile.`, `/people/${v.employeeId}?tab=finances`);
  }
  return { id: row.id, unchanged: false, arrearsFromMonth: arrears, pendingApproval: false };
}

/** Whether salary revisions need approval: yes when an active workflow for them exists. */
export async function revisionsNeedApproval(tx: Tx) {
  return (await tx`select 1 from approval_workflows where entity_type = 'salary_revision' and is_active limit 1`).length > 0;
}

/** Remove a salary record payroll hasn't used yet (e.g. a mistaken or cancelled future revision). */
export async function deleteSalary(tx: Tx, actor: Actor, salaryId: string) {
  const [s] = await tx<{ employee_id: string; effective_from: string; used: boolean; status: string }[]>`
    select employee_id, effective_from::text, exists (select 1 from payroll_lines l where l.salary_id = s.id) as used, status from employee_salaries s where id = ${salaryId}`;
  if (!s) throw new AppError("not_found", "Salary record not found.");
  await assertCanChangePay(tx, actor, s.employee_id);
  if (s.used) throw new AppError("invalid", "Payroll has already used this salary. Add a correction revision instead.");
  if (s.status === "pending_approval") {
    await cancelApproval(tx, "salary_revision", salaryId);
    await tx`delete from employee_salaries where id = ${salaryId}`;
    await audit(tx, actor, { entityType: "employee_salary", entityId: salaryId, action: "salary.revision_withdrawn", diff: { employeeId: s.employee_id, effectiveFrom: s.effective_from } });
    return;
  }
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from employee_salaries where employee_id = ${s.employee_id} and effective_from > ${s.effective_from}`;
  const [{ m }] = await tx<{ m: number }[]>`select count(*)::int as m from employee_salaries where employee_id = ${s.employee_id}`;
  if (n > 0 && m > 1 && (await tx`select 1 from employee_salaries where employee_id = ${s.employee_id} and effective_from < ${s.effective_from} limit 1`).length === 0)
    throw new AppError("invalid", "This is the first salary and later revisions build on it. Delete the later ones first.");
  await tx`delete from employee_salaries where id = ${salaryId}`;
  await restatus(tx, s.employee_id);
  await markPersonRunsStale(tx, s.employee_id, s.effective_from);
  await audit(tx, actor, { entityType: "employee_salary", entityId: salaryId, action: "salary.delete", diff: { employeeId: s.employee_id, effectiveFrom: s.effective_from } });
}

// ---------------------------------------------------------------- bank account

const bankInput = z.object({
  bankName: z.string().trim().min(2, "Enter the bank's name").max(80),
  ifsc: z.string().transform(normaliseIfsc).refine(isIfsc, "IFSC codes have 11 characters: 4 letters, a zero, then 6 letters or digits (like HDFC0001234)"),
  accountNumber: z.string().transform(normaliseAccount).refine(isAccountNumber, "Account numbers are 9 to 18 digits"),
  holderName: z.string().trim().min(2, "Enter the name on the account").max(120),
});

const bankScope = (tenantId: string, employeeId: string) => ["bank_account", tenantId, employeeId];

/** Save (replace) the primary bank account. The number is encrypted at rest; only the last 4 digits are ever shown. */
export async function saveBankAccount(tx: Tx, actor: Actor, employeeId: string, raw: unknown, opts: { notify?: boolean } = {}) {
  await assertCanChangePay(tx, actor, employeeId);
  const p = bankInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  const enc = encryptField(v.accountNumber, bankScope(actor.tenant.id, employeeId));
  const [cur] = await tx<{ id: string }[]>`select id from employee_bank_accounts where employee_id = ${employeeId} and is_primary`;
  if (cur) await tx`update employee_bank_accounts set bank_name = ${v.bankName}, ifsc = ${v.ifsc}, account_number_enc = ${enc}, account_last4 = ${last4(v.accountNumber)}, holder_name = ${v.holderName}, updated_at = now() where id = ${cur.id}`;
  else await tx`insert into employee_bank_accounts (tenant_id, employee_id, bank_name, ifsc, account_number_enc, account_last4, holder_name) values (${actor.tenant.id}, ${employeeId}, ${v.bankName}, ${v.ifsc}, ${enc}, ${last4(v.accountNumber)}, ${v.holderName})`;
  await audit(tx, actor, { entityType: "employee_bank_account", entityId: employeeId, action: "bank.update", diff: { employeeId, bankName: v.bankName, ifsc: v.ifsc, last4: last4(v.accountNumber) } });
  if (opts.notify !== false) await notifyEmployee(tx, actor.tenant.id, employeeId, "bank.updated", "Your salary bank account was changed",
    `Salary will be paid to ${v.bankName} account ending ${last4(v.accountNumber)}. Tell HR straight away if you didn't ask for this.`, `/people/${employeeId}?tab=finances`);
}

/** The full account number, for bank transfer files. Server-side only; never send it to a browser. */
export async function bankAccountFor(tx: Tx, tenantId: string, employeeId: string) {
  const [b] = await tx<{ bank_name: string; ifsc: string; account_number_enc: Uint8Array; holder_name: string }[]>`
    select bank_name, ifsc, account_number_enc, holder_name from employee_bank_accounts where employee_id = ${employeeId} and is_primary`;
  if (!b) return null;
  return { bankName: b.bank_name, ifsc: b.ifsc, holderName: b.holder_name, accountNumber: decryptField(b.account_number_enc, bankScope(tenantId, employeeId)) };
}

// ---------------------------------------------------------------- statutory profile

const opt = (re: (s: string) => boolean, msg: string) => z.string().trim().transform((s) => s.toUpperCase().replace(/\s+/g, "")).nullable().optional()
  .transform((s) => s || null).refine((s) => s === null || re(s), msg);
const statutoryInput = z.object({
  pfEnabled: z.boolean(),
  uan: opt(isUan, "UANs are 12 digits"),
  pfNumber: opt(isPfNumber, "PF numbers look like KABNG00123450000012345"),
  pfOnFullWage: z.boolean(),
  esiEnabled: z.boolean(),
  esiNumber: opt(isEsiNumber, "ESI numbers are 10 digits"),
  ptState: opt(isStateCode, "Pick a state"),
  lwfState: opt(isStateCode, "Pick a state"),
  taxRegime: z.enum(["old", "new"]),
});

export async function saveStatutory(tx: Tx, actor: Actor, employeeId: string, raw: unknown) {
  await assertCanChangePay(tx, actor, employeeId);
  const p = statutoryInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  await tx`
    insert into employee_statutory (employee_id, tenant_id, pf_enabled, uan, pf_number, pf_on_full_wage, esi_enabled, esi_number, pt_state, lwf_state, tax_regime)
    values (${employeeId}, ${actor.tenant.id}, ${v.pfEnabled}, ${v.uan}, ${v.pfNumber}, ${v.pfEnabled && v.pfOnFullWage}, ${v.esiEnabled}, ${v.esiNumber}, ${v.ptState}, ${v.lwfState}, ${v.taxRegime})
    on conflict (employee_id) do update set pf_enabled = excluded.pf_enabled, uan = excluded.uan, pf_number = excluded.pf_number, pf_on_full_wage = excluded.pf_on_full_wage,
      esi_enabled = excluded.esi_enabled, esi_number = excluded.esi_number, pt_state = excluded.pt_state, lwf_state = excluded.lwf_state, tax_regime = excluded.tax_regime, updated_at = now()`;
  await markPersonRunsStale(tx, employeeId);
  await audit(tx, actor, { entityType: "employee_statutory", entityId: employeeId, action: "statutory.update", diff: { employeeId, ...v } });
}

// ---------------------------------------------------------------- the profile's Finances tab

export type FinancesView = {
  self: boolean; canEdit: boolean; name: string;
  current: (ActiveSalary & { lines: { code: string; name: string; kind: ComponentKind; monthlyPaise: number }[] }) | null;
  upcoming: { effectiveFrom: string; ctcPaise: number }[];
  history: { id: string; effectiveFrom: string; ctcPaise: number; reason: string; structureName: string; arrearsFromMonth: string | null; status: string; createdAt: string; deletable: boolean }[];
  /** revisions waiting for approval (the approvals engine decides them) */
  pending: { id: string; effectiveFrom: string; ctcPaise: number; reason: string; structureName: string; arrearsFromMonth: string | null; createdAt: string; requestedBy: string | null; waitingOn: string | null }[];
  revisionsNeedApproval: boolean;
  statutory: StatutoryProfile;
  bank: { bankName: string; ifsc: string; last4: string; holderName: string; updatedAt: string } | null;
  payGroup: { id: string; name: string } | null;
  structures: Pick<StructureRow, "id" | "name" | "pay_group_id" | "pay_group" | "lines">[];
  states: typeof INDIAN_STATES;
  today: string;
};

/** Everything the Finances tab shows, or null when the actor may not see this person's pay (not self, not payroll admin in scope). */
export async function financesFor(tx: Tx, actor: Actor, employeeId: string): Promise<FinancesView | null> {
  const p = await placementOf(tx, employeeId);
  if (!p) return null;
  const self = actor.employeeId === employeeId;
  const admin = canPayrollFor(actor, p);
  if (!self && !admin) return null;
  const today = todayIn();
  const rows = await tx<(SalaryRow & { used: boolean })[]>`
    select ${salaryCols(tx)}, exists (select 1 from payroll_lines l where l.salary_id = s.id) as used
    from employee_salaries s join salary_structures st on st.id = s.structure_id
    where s.employee_id = ${employeeId} and s.status in ('active','superseded') order by s.effective_from desc`;
  const currentRow = rows.find((r) => r.effective_from <= today) ?? null;
  const comps = await tx<{ code: string; name: string; kind: ComponentKind }[]>`select code, name, kind from salary_components`;
  const lineOrder = currentRow ? (await tx<{ code: string }[]>`select c.code from salary_structure_lines l join salary_components c on c.id = l.component_id where l.structure_id = ${currentRow.structure_id} order by l.position`).map((x) => x.code) : [];
  const current = currentRow ? (() => {
    const s = toSalary(currentRow);
    const codes = [...lineOrder.filter((c) => c in s.breakup), ...Object.keys(s.breakup).filter((c) => !lineOrder.includes(c))];
    return { ...s, lines: codes.map((c) => { const k = comps.find((x) => x.code === c); return { code: c, name: k?.name ?? c, kind: k?.kind ?? "earning", monthlyPaise: s.breakup[c] }; }) };
  })() : null;
  const [bank] = await tx<{ bank_name: string; ifsc: string; account_last4: string; holder_name: string; updated_at: Date }[]>`
    select bank_name, ifsc, account_last4, holder_name, updated_at from employee_bank_accounts where employee_id = ${employeeId} and is_primary`;
  const [pg] = await tx<{ id: string; name: string }[]>`select g.id, g.name from employees e join pay_groups g on g.id = e.pay_group_id where e.id = ${employeeId}`;
  const canEdit = admin && !self;
  const pendingRows = await tx<(SalaryRow & { requested_by: string | null; waiting_on: string | null })[]>`
    select ${salaryCols(tx)}, (select display_name from employees b where b.user_id = s.created_by) as requested_by,
      (select a.display_name from approval_requests r join approval_steps x on x.request_id = r.id and x.status = 'pending' join employees a on a.id = x.approver_employee_id
        where r.entity_type = 'salary_revision' and r.entity_id = s.id and r.status = 'pending' limit 1) as waiting_on
    from employee_salaries s join salary_structures st on st.id = s.structure_id
    where s.employee_id = ${employeeId} and s.status = 'pending_approval' order by s.effective_from`;
  return {
    self, canEdit, name: p.display_name, current,
    pending: pendingRows.map((r) => ({ id: r.id, effectiveFrom: r.effective_from, ctcPaise: Number(r.ctc_paise), reason: r.reason, structureName: r.structure_name, arrearsFromMonth: r.arrears_from_month, createdAt: r.created_at.toISOString(), requestedBy: r.requested_by, waitingOn: r.waiting_on })),
    revisionsNeedApproval: await revisionsNeedApproval(tx),
    upcoming: rows.filter((r) => r.effective_from > today).map((r) => ({ effectiveFrom: r.effective_from, ctcPaise: Number(r.ctc_paise) })).reverse(),
    history: rows.map((r) => ({ id: r.id, effectiveFrom: r.effective_from, ctcPaise: Number(r.ctc_paise), reason: r.reason, structureName: r.structure_name, arrearsFromMonth: r.arrears_from_month, status: r.effective_from > today ? "upcoming" : r.id === currentRow?.id ? "current" : "past", createdAt: r.created_at.toISOString(), deletable: canEdit && !r.used })),
    statutory: await getStatutoryProfile(tx, employeeId),
    bank: bank ? { bankName: bank.bank_name, ifsc: bank.ifsc, last4: bank.account_last4, holderName: bank.holder_name, updatedAt: bank.updated_at.toISOString() } : null,
    payGroup: pg ?? null,
    structures: canEdit ? (await listStructures(tx)).filter((s) => !pg || s.pay_group_id === pg.id).map((s) => ({ id: s.id, name: s.name, pay_group_id: s.pay_group_id, pay_group: s.pay_group, lines: s.lines })) : [],
    states: INDIAN_STATES, today,
  };
}

/** A pending (or decided) revision for the inbox drawer: the person, old and new CTC, and the approval steps. Approvers in its chain and payroll admins in scope may see it. */
export async function revisionDetail(tx: Tx, actor: Actor, salaryId: string) {
  const [r] = await tx<{ id: string; employee_id: string; name: string; number: string; ctc_paise: bigint; effective_from: string; reason: string; arrears_from_month: string | null; structure: string; status: string; created_at: Date; by: string | null }[]>`
    select s.id, s.employee_id, e.display_name as name, e.employee_number as number, s.ctc_paise, s.effective_from::text, s.reason, s.arrears_from_month::text, st.name as structure, s.status, s.created_at,
      (select display_name from employees b where b.user_id = s.created_by) as by
    from employee_salaries s join employees e on e.id = s.employee_id join salary_structures st on st.id = s.structure_id where s.id = ${salaryId}`;
  if (!r) return null;
  const [step] = await tx<{ id: string }[]>`select x.id from approval_requests q join approval_steps x on x.request_id = q.id where q.entity_type = 'salary_revision' and q.entity_id = ${salaryId} and x.approver_employee_id = ${actor.employeeId} limit 1`;
  const p = await placementOf(tx, r.employee_id);
  if (!step && !(p && canPayrollFor(actor, p))) return null;
  const before = await getActiveSalary(tx, r.employee_id, r.effective_from);
  const steps = await timeline(tx, "salary_revision", salaryId);
  return {
    id: r.id, employee: { id: r.employee_id, name: r.name, number: r.number }, currentCtcPaise: before && before.effectiveFrom < r.effective_from ? before.ctcPaise : null, newCtcPaise: Number(r.ctc_paise),
    effectiveFrom: r.effective_from, reason: r.reason, structure: r.structure, arrearsFromMonth: r.arrears_from_month, status: r.status, requestedBy: r.by, requestedAt: r.created_at.toISOString(),
    steps: steps.map((x) => ({ ...x, acted_at: x.acted_at?.toISOString() ?? null })),
  };
}
