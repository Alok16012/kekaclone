import "server-only";
import { AppError, type Tx } from "@/server/db";
import { calendarFor } from "@/server/modules/leave/service";
import { countLeaveDays, dayType, type Calendar } from "@/server/modules/leave/rules";
import { loadRates, type EffectiveRates } from "@/server/modules/statutory/service";
import { esiCoverageMonth, fyOf, fyRange, type Gender } from "@/server/modules/statutory/rules";
import { taxInputsFor } from "./tax-inputs";
import {
  addMonths, ageBandFor, arrearsDue, attendanceWindows, buildSegments, computeLine, dayRate, eachDate, epsMember, halfYear, isLockedStatus, metaFor, monthEnd,
  periodDays, prorate, remainingMonths, valueDays, type Basis, type ComponentMeta, type ExtraItem, type LineAction, type LineResult, type PayItem, type StatutoryOverrides,
} from "./rules";

export type StepState = {
  reviewed?: Record<string, { by: string; at: string }>;
  computedVersion?: number; computedAt?: string;
  rollback?: { by: string; at: string; reason: string };
};
export type RunTotals = {
  headcount?: number; processed?: number; held?: number; gross?: number; deductions?: number; net?: number; employer?: number; cost?: number;
  warnings?: number; negative?: number; noSalary?: { id: string; name: string }[];
};
export type RunRow = {
  id: string; pay_group_id: string; period_month: string; status: string; step_state: StepState; totals: RunTotals; lock_version: number;
  finalized_at: Date | null; finalized_by: string | null; created_at: Date;
  pay_group: string; cutoff: number; basis: Basis; legal_entity_id: string; legal_entity: string;
};

export async function getRun(tx: Tx, runId: string, forUpdate = false) {
  const [r] = await tx<RunRow[]>`
    select r.id, r.pay_group_id, r.period_month::text, r.status, r.step_state, r.totals, r.lock_version, r.finalized_at, r.finalized_by, r.created_at,
      g.name as pay_group, g.attendance_cutoff_day as cutoff, g.payable_days_basis as basis, g.legal_entity_id, le.name as legal_entity
    from payroll_runs r join pay_groups g on g.id = r.pay_group_id join legal_entities le on le.id = g.legal_entity_id
    where r.id = ${runId} ${forUpdate ? tx`for update of r` : tx``}`;
  if (!r) throw new AppError("not_found", "Payroll run not found.");
  return r;
}

/** Bump the run's version if it still has the one the caller saw (optimistic lock). */
export async function bumpVersion(tx: Tx, runId: string, expected: number | null | undefined) {
  const rows = await tx<{ lock_version: number }[]>`
    update payroll_runs set lock_version = lock_version + 1, updated_at = now()
    where id = ${runId} ${expected == null ? tx`` : tx`and lock_version = ${expected}`} returning lock_version`;
  if (!rows.length) throw new AppError("conflict", "Someone else changed this run since you opened it. Reload the page to see their changes.");
  return rows[0].lock_version;
}

// ---------------------------------------------------------------- loading

export type RunPerson = {
  id: string; number: string; name: string; joining_date: string; dob: string | null; gender: string | null; status: string;
  last_day: string | null; exit_status: string | null; exit_id: string | null; has_bank: boolean; has_pan: boolean; designation: string | null; department: string | null;
};

/** People in the pay group who were employed for at least a day of the month. */
export async function runPeople(tx: Tx, payGroupId: string, month: string): Promise<RunPerson[]> {
  const rows = await tx<RunPerson[]>`
    select e.id, e.employee_number as number, e.display_name as name, e.joining_date::text, e.dob::text, e.gender, e.status,
      coalesce(x.last_working_date, e.exit_date)::text as last_day, x.status as exit_status, x.id as exit_id,
      exists (select 1 from employee_bank_accounts b where b.employee_id = e.id and b.is_primary) as has_bank,
      exists (select 1 from employee_identities i where i.employee_id = e.id and i.kind = 'pan') as has_pan,
      d.title as designation, dp.name as department
    from employees e
    left join lateral (select id, status, last_working_date from exit_requests q where q.employee_id = e.id and q.status in ('in_progress','exited') order by q.created_at desc limit 1) x on true
    left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    where e.pay_group_id = ${payGroupId} and e.status <> 'preboarding' and e.joining_date <= ${monthEnd(month)}
    order by e.employee_number`;
  return rows.filter((p) => !p.last_day || p.last_day >= month);
}

type SalaryRec = { id: string; employee_id: string; effective_from: string; breakup: Record<string, number>; arrears_from_month: string | null };
type InputRow = {
  id: string; employee_id: string; kind: string; component_id: string | null; amount_paise: bigint | null; days: string | null; source_month: string | null;
  source_ref: Record<string, unknown> | null; action: string; note: string | null; created_at: Date;
  code: string | null; cname: string | null; ckind: string | null; is_taxable: boolean | null; pf_wage: boolean | null; esi_wage: boolean | null;
};
type DayRow = { employee_id: string; date: string; status: string; penalties: { deductions?: { days: number; leaveTypeId: string | null }[] }[]; overtime_minutes: number; day_type: string };

export async function components(tx: Tx): Promise<Record<string, ComponentMeta>> {
  const rows = await tx<{ code: string; name: string; kind: string; is_taxable: boolean; lop_prorated: boolean; pf_wage: boolean; esi_wage: boolean; in_arrears: boolean; on_payslip: boolean }[]>`
    select c.code, c.name, c.kind, c.is_taxable, c.lop_prorated, c.pf_wage, c.esi_wage, c.in_arrears, c.on_payslip from salary_components c
    order by (select min(l.position) from salary_structure_lines l where l.component_id = c.id) nulls last, c.code`;
  return Object.fromEntries(rows.map((c, rank) => [c.code, { code: c.code, name: c.name, kind: c.kind, taxable: c.is_taxable, lopProrated: c.lop_prorated, pfWage: c.pf_wage, esiWage: c.esi_wage, inArrears: c.in_arrears, onPayslip: c.on_payslip, rank }]));
}

const lopOf = (r: DayRow) => (r.penalties ?? []).reduce((t, p) => t + (p.deductions ?? []).filter((d) => d.leaveTypeId == null).reduce((s, d) => s + Number(d.days || 0), 0), 0);
const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));

/** Everything the run needs about a batch of people, loaded in a few queries. */
export type PersonData = {
  person: RunPerson; salaries: SalaryRec[]; lopByDate: Record<string, number>; currentLop: number; rolledLop: number; lateLop: number;
  unpaidLeaveDays: number; absentNoLop: number; overtimeMinutes: number; inputs: InputRow[]; cal: Calendar | null;
  statutory: { pf_enabled: boolean | null; pf_on_full_wage: boolean | null; esi_enabled: boolean | null; uan: string | null; pt_state: string | null; lwf_state: string | null; tax_regime: "old" | "new" | null; location_state: string | null };
  ytd: { taxable: number; tds: number; pt: number; halfGross: number };
};

export async function loadPeople(tx: Tx, run: Pick<RunRow, "pay_group_id" | "period_month" | "cutoff" | "basis">, people: RunPerson[]): Promise<PersonData[]> {
  const M = run.period_month, end = monthEnd(M), ids = people.map((p) => p.id);
  if (!ids.length) return [];
  const w = attendanceWindows(M, run.cutoff);
  const from = w.rolled?.from ?? M;
  const fy = fyRange(fyOf(M)).from, half = halfYear(M).start;
  const [salaries, days, leaves, inputs, st, ytd] = await Promise.all([
    tx<SalaryRec[]>`select id, employee_id, effective_from::text, breakup, arrears_from_month::text from employee_salaries
                    where employee_id = any(${ids}::uuid[]) and status in ('active','superseded') and effective_from <= ${end} order by effective_from`,
    tx<DayRow[]>`select employee_id, date::text, status, penalties, overtime_minutes, day_type from attendance_days where employee_id = any(${ids}::uuid[]) and date between ${from} and ${end}`,
    tx<{ employee_id: string; from_date: string; to_date: string; from_half: "full" | "first" | "second"; to_half: "full" | "first" | "second" }[]>`
      select r.employee_id, r.from_date::text, r.to_date::text, r.from_half, r.to_half from leave_requests r join leave_types t on t.id = r.leave_type_id
      where r.employee_id = any(${ids}::uuid[]) and r.status = 'approved' and not t.is_paid and r.to_date >= ${from} and r.from_date <= ${end}`,
    tx<InputRow[]>`select i.id, i.employee_id, i.kind, i.component_id, i.amount_paise, i.days::text, i.source_month::text, i.source_ref, i.action, i.note, i.created_at,
                     c.code, c.name as cname, c.kind as ckind, c.is_taxable, c.pf_wage, c.esi_wage
                   from payroll_inputs i left join salary_components c on c.id = i.component_id
                   where i.pay_group_id = ${run.pay_group_id} and i.period_month = ${M} and i.employee_id = any(${ids}::uuid[]) order by i.created_at, i.id`,
    tx<(PersonData["statutory"] & { employee_id: string })[]>`
      select e.id as employee_id, s.pf_enabled, s.pf_on_full_wage, s.esi_enabled, s.uan, s.pt_state, s.lwf_state, s.tax_regime, l.state_code as location_state
      from employees e left join employee_statutory s on s.employee_id = e.id left join locations l on l.id = e.location_id where e.id = any(${ids}::uuid[])`,
    tx<{ employee_id: string; taxable: string; tds: string; pt: string; half_gross: string }[]>`
      select l.employee_id,
        coalesce(sum((l.statutory->>'taxablePaise')::bigint), 0)::text as taxable,
        coalesce(sum((l.statutory->'tds'->>'monthlyPaise')::bigint), 0)::text as tds,
        coalesce(sum((l.statutory->'pt'->>'amountPaise')::bigint), 0)::text as pt,
        coalesce(sum((l.statutory->'pt'->>'grossPaise')::bigint) filter (where r.period_month >= ${half}), 0)::text as half_gross
      from payroll_lines l join payroll_runs r on r.id = l.run_id
      where l.employee_id = any(${ids}::uuid[]) and r.status in ('finalized','payslips_released','paid') and r.period_month >= ${fy} and r.period_month < ${M}
      group by l.employee_id`,
  ]);
  const out: PersonData[] = [];
  for (const p of people) {
    const mine = days.filter((d) => d.employee_id === p.id);
    const myLeaves = leaves.filter((l) => l.employee_id === p.id);
    const cal = myLeaves.length || run.basis === "working" ? await calendarFor(tx, p.id) : null;
    const lopByDate: Record<string, number> = {};
    for (const d of mine) { const v = lopOf(d); if (v) lopByDate[d.date] = v; }
    let unpaid = 0;
    for (const l of myLeaves) {
      for (const b of countLeaveDays(l.from_date, l.to_date, l.from_half, l.to_half, cal!).breakdown) {
        if (b.counted <= 0 || b.date < from || b.date > end) continue;
        lopByDate[b.date] = Math.min(1, (lopByDate[b.date] ?? 0) + b.counted);
        if (b.date >= w.current.from && b.date <= w.current.to) unpaid += b.counted;
      }
    }
    const inWin = (d: string, a: { from: string; to: string } | null) => !!a && d >= a.from && d <= a.to;
    const sumIn = (a: { from: string; to: string } | null) => Object.entries(lopByDate).filter(([d]) => inWin(d, a)).reduce((t, [, v]) => t + v, 0);
    const y = ytd.find((r) => r.employee_id === p.id);
    out.push({
      person: p, salaries: salaries.filter((s) => s.employee_id === p.id), lopByDate,
      currentLop: sumIn(w.current), rolledLop: sumIn(w.rolled), lateLop: w.lateFrom ? sumIn({ from: w.lateFrom, to: end }) : 0, unpaidLeaveDays: unpaid,
      absentNoLop: mine.filter((d) => inWin(d.date, w.current) && d.status === "absent" && !lopByDate[d.date]).length,
      overtimeMinutes: mine.filter((d) => inWin(d.date, w.current)).reduce((t, d) => t + (d.overtime_minutes ?? 0), 0),
      inputs: inputs.filter((i) => i.employee_id === p.id), cal,
      statutory: st.find((s) => s.employee_id === p.id)!,
      ytd: { taxable: N(y?.taxable), tds: N(y?.tds), pt: N(y?.pt), halfGross: N(y?.half_gross) },
    });
  }
  return out;
}

// ---------------------------------------------------------------- one person's line

const workingSet = (cal: Calendar | null, month: string) => cal ? new Set(eachDate(month, monthEnd(month)).filter((d) => dayType(d, cal) !== "holiday" && dayType(d, cal) !== "weekly_off")) : undefined;
/** Salary records relevant to a month: the one in force on the 1st plus any that start during it. */
const forMonth = (salaries: SalaryRec[], month: string) => {
  const end = monthEnd(month);
  const before = salaries.filter((s) => s.effective_from <= month);
  return [...(before.length ? [before[before.length - 1]] : []), ...salaries.filter((s) => s.effective_from > month && s.effective_from <= end)];
};
const inForce = (salaries: SalaryRec[], date: string) => [...salaries].reverse().find((s) => s.effective_from <= date) ?? null;

export type LineDraft = {
  employeeId: string; salaryId: string | null; action: LineAction; periodDays: number; payableDays: number; lopDays: number;
  result: LineResult; context: Record<string, unknown>;
};

type Shared = { components: Record<string, ComponentMeta>; rates: Map<string, EffectiveRates>; prevLocked: boolean; tenantId: string; settledInFnf?: Set<string> };

async function ratesFor(tx: Tx, shared: Shared, month: string, state: string | null) {
  const k = state ?? "";
  if (!shared.rates.has(k)) {
    try { shared.rates.set(k, await loadRates(tx, month, state)); } catch (e) {
      if (e instanceof AppError) throw new AppError("invalid", `${e.message} Load the statutory rates (pnpm jobs:statutory-rates) before running payroll.`);
      throw e;
    }
  }
  return shared.rates.get(k)!;
}

const extra = (i: InputRow, side: "earning" | "deduction", fallback: { code: string; label: string; taxable: boolean; pf?: boolean; esi?: boolean; kind?: PayItem["kind"] }): ExtraItem => ({
  code: i.code ?? fallback.code, label: i.note?.trim() || i.cname || fallback.label, paise: N(i.amount_paise), kind: fallback.kind ?? "input", side, inputId: i.id,
  taxable: i.is_taxable ?? fallback.taxable, pfWage: i.pf_wage ?? fallback.pf ?? false, esiWage: i.esi_wage ?? fallback.esi ?? false,
});

/** Previous months' lines and arrears already paid, for the arrears calculation. */
async function arrearsFor(tx: Tx, run: RunRow, d: PersonData, shared: Shared): Promise<ExtraItem[]> {
  const M = run.period_month;
  const flagged = d.salaries.map((s) => s.arrears_from_month).filter((m): m is string => !!m && m < M).sort()[0] ?? null;
  const floor = addMonths(M, -12);
  const lines = await tx<{ month: string; action: string; lop_days: string; earnings: PayItem[] }[]>`
    select r.period_month::text as month, l.action, l.lop_days::text, l.earnings from payroll_lines l join payroll_runs r on r.id = l.run_id
    where l.employee_id = ${d.person.id} and r.status in ('finalized','payslips_released','paid') and r.period_month >= ${floor} and r.period_month < ${M}`;
  const candidates = lines.filter((l) => l.action !== "void" && (l.action === "hold_processing" || (flagged && l.month >= flagged)));
  if (!candidates.length) return [];
  const later = lines.flatMap((l) => (l.earnings ?? []).filter((e) => e.sourceMonth && (e.kind === "arrear" || e.kind === "lop")));
  const months = [];
  for (const c of candidates) {
    const sal = forMonth(d.salaries, c.month);
    if (!sal.length) continue;
    const held = c.action === "hold_processing";
    // each LOP adjustment adds one item per component, all carrying the same days: count each adjustment once
    const seen = new Set<string>();
    let lopAdj = 0;
    for (const e of later) {
      if (e.kind !== "lop" || e.sourceMonth !== c.month) continue;
      const k = e.inputId ?? e.label.split(":")[0];
      if (!seen.has(k)) { seen.add(k); lopAdj += Number(e.days ?? 0); }
    }
    const from = d.person.joining_date > c.month ? d.person.joining_date : c.month;
    const to = d.person.last_day && d.person.last_day < monthEnd(c.month) ? d.person.last_day : monthEnd(c.month);
    const wd = run.basis === "working" ? workingSet(d.cal, c.month) : undefined;
    const segs = buildSegments({ month: c.month, basis: run.basis, workingDates: wd, employedFrom: from, employedTo: to, salaries: sal.map((s) => ({ id: s.id, effectiveFrom: s.effective_from, breakup: s.breakup })), lopByDate: {}, undatedLop: Number(c.lop_days) + lopAdj });
    const period = periodDays(c.month, run.basis, wd);
    const expected: Record<string, number> = {}, paid: Record<string, number> = {};
    const codes = new Set(sal.flatMap((s) => Object.keys(s.breakup)));
    for (const code of codes) {
      const m = metaFor(shared.components, code);
      if (m.kind !== "employer_contribution") expected[code] = prorate(code, segs, period, m.lopProrated);
    }
    const add = (code: string, v: number) => { paid[code] = (paid[code] ?? 0) + v; };
    for (const e of c.earnings ?? []) if (e.kind === "salary" || e.kind === "reimbursement") add(e.code, e.paise);
    for (const e of later) if (e.sourceMonth === c.month) add(e.code.replace(/^(ARR|LOP)_/, ""), e.paise);
    // differences of a rupee or less are rounding between day values and proration; ignore them unless the month was held
    if (!held) for (const k of Object.keys(expected)) if (Math.abs((expected[k] ?? 0) - (paid[k] ?? 0)) <= 100) expected[k] = paid[k] ?? 0;
    months.push({ month: c.month, expected, paid });
  }
  return arrearsDue(months, shared.components).map((a) => (a.paise ? a : null)).filter((a): a is ExtraItem => !!a);
}

/** One person's pay for the run's month (pure maths in rules.ts; this gathers the inputs). */
export async function draftLine(tx: Tx, run: RunRow, d: PersonData, shared: Shared): Promise<LineDraft | null> {
  const M = run.period_month, end = monthEnd(M), p = d.person;
  const sal = forMonth(d.salaries, M);
  // pay actions: the latest one wins
  let action: LineAction = "process";
  for (const i of d.inputs) {
    if (i.action !== "pay") continue;
    if (i.kind === "processing_hold") action = "hold_processing";
    else if (i.kind === "payout_hold") action = "hold_payout";
    else if (i.kind === "pay_action" && typeof i.source_ref?.action === "string") action = i.source_ref.action as LineAction;
  }
  if (shared.settledInFnf?.has(p.id)) action = "void";
  if (!sal.length) return null;
  const from = p.joining_date > M ? p.joining_date : M;
  const to = p.last_day && p.last_day < end ? p.last_day : end;
  const wd = run.basis === "working" ? workingSet(d.cal, M) : undefined;
  const period = periodDays(M, run.basis, wd);
  const w = attendanceWindows(M, run.cutoff);
  const lopByDate = Object.fromEntries(Object.entries(d.lopByDate).filter(([k]) => k >= w.current.from && k <= w.current.to));

  // inputs → extras, LOP changes and overrides
  const extras: ExtraItem[] = [];
  const overrides: StatutoryOverrides = {};
  let undatedLop = 0;
  const latestSalaryAt = (month: string) => inForce(d.salaries, monthEnd(month));
  const lopItems = (month: string, days: number, sign: 1 | -1, label: string, inputId?: string) => {
    const s = latestSalaryAt(month);
    if (!s) return;
    const period2 = periodDays(month, run.basis, run.basis === "working" ? workingSet(d.cal, month) : undefined);
    for (const [code, v] of Object.entries(valueDays(s.breakup, shared.components, days, period2))) {
      const m = metaFor(shared.components, code);
      extras.push({ code: `LOP_${code}`, label: `${label}: ${m.name}`, paise: sign * v, kind: "lop", side: "earning", sourceMonth: month, inputId,
        taxable: m.taxable, pfWage: m.pfWage, esiWage: m.esiWage, days: -sign * days });
    }
  };
  for (const i of d.inputs) {
    if (i.action !== "pay" && i.action !== "partial") continue;
    const days = Number(i.days ?? 0);
    switch (i.kind) {
      case "bonus": extras.push(extra(i, "earning", { code: "BONUS", label: "Bonus", taxable: true })); break;
      case "adhoc_earning": extras.push(extra(i, "earning", { code: "ADHOC_EARNING", label: "One-time payment", taxable: true })); break;
      case "arrear": extras.push(extra(i, "earning", { code: "ARREAR", label: "Arrears", taxable: true, kind: "arrear" })); break;
      case "overtime": extras.push(extra(i, "earning", { code: "OVERTIME", label: "Overtime", taxable: true, esi: true })); break;
      case "shift_allowance": extras.push(extra(i, "earning", { code: "SHIFT_ALLOWANCE", label: "Shift allowance", taxable: true, esi: true })); break;
      case "component_claim": extras.push(extra(i, "earning", { code: "CLAIM", label: "Reimbursement", taxable: false, kind: "reimbursement" })); break;
      case "expense": extras.push({ ...extra(i, "earning", { code: "EXPENSE", label: "Expense reimbursement", taxable: false, kind: "reimbursement" }), taxable: false, pfWage: false, esiWage: false }); break;
      case "adhoc_deduction": extras.push(extra(i, "deduction", { code: "ADHOC_DEDUCTION", label: "Deduction", taxable: false })); break;
      case "loan_emi": extras.push(extra(i, "deduction", { code: "LOAN_EMI", label: "Loan repayment", taxable: false })); break;
      case "leave_encashment": {
        const basic = inForce(d.salaries, to)?.breakup.BASIC ?? 0;
        const amount = i.amount_paise != null ? N(i.amount_paise) : dayRate(basic, days);
        extras.push({ code: "LEAVE_ENCASH", label: i.note?.trim() || `Leave encashment (${days} days)`, paise: amount, kind: "input", side: "earning", inputId: i.id, taxable: true, pfWage: false, esiWage: false });
        break;
      }
      case "lop_adjust": case "lop_reversal": {
        const sign = i.kind === "lop_adjust" ? 1 : -1;
        const src = i.source_month ?? M;
        if (src === M) undatedLop += sign * days;
        else lopItems(src, days, sign === 1 ? -1 : 1, i.kind === "lop_adjust" ? `Loss of pay (${src.slice(0, 7)})` : `Loss of pay reversed (${src.slice(0, 7)})`, i.id);
        break;
      }
      case "statutory_override": {
        const code = String(i.source_ref?.code ?? "");
        if (["PF_EMPLOYEE", "ESI", "PT", "LWF", "TDS"].includes(code)) overrides[code as keyof StatutoryOverrides] = N(i.amount_paise);
        break;
      }
    }
  }
  // LOP after last month's cut-off, valued at last month's rate (only once erp has paid last month)
  if (shared.prevLocked && w.rolled && d.rolledLop > 0) lopItems(w.rolled.month, d.rolledLop, -1, `Loss of pay ${w.rolled.from.slice(8)}–${w.rolled.to.slice(8)} ${w.rolled.month.slice(0, 7)}`);

  const segments = buildSegments({ month: M, basis: run.basis, workingDates: wd, employedFrom: from, employedTo: to,
    salaries: sal.map((s) => ({ id: s.id, effectiveFrom: s.effective_from, breakup: s.breakup })), lopByDate, undatedLop: Math.max(0, undatedLop) });
  if (undatedLop < 0) {   // a reversal of this month's own LOP gives days back, never beyond the employed days
    const last = segments[segments.length - 1];
    if (last) last.payableDays = Math.min(last.employedDays, last.payableDays - undatedLop);
  }
  const employed = segments.reduce((t, s) => t + s.employedDays, 0), payable = segments.reduce((t, s) => t + s.payableDays, 0);
  const lopDays = Math.round((employed - payable) * 100) / 100;
  const current = sal[sal.length - 1];
  const context = { joining: p.joining_date, lastDay: p.last_day, exitStatus: p.exit_status, currentLop: d.currentLop, rolledLop: shared.prevLocked ? d.rolledLop : 0,
    lateLop: d.lateLop, unpaidLeaveDays: d.unpaidLeaveDays, absentNoLop: d.absentNoLop, overtimeMinutes: d.overtimeMinutes, employedDays: employed, segments: segments.length };

  if (action === "hold_processing" || action === "void") {
    const empty: LineResult = { earnings: [], deductions: [], employer: [], grossPaise: 0, totalDeductionsPaise: 0, netPaise: 0, payableDays: payable, employedDays: employed,
      statutory: { pf: null, esi: null, pt: null, lwf: null, tds: null, taxablePaise: 0, overrides: {} },
      warnings: [shared.settledInFnf?.has(p.id) ? "Final month's salary is paid in the full and final settlement." : action === "void" ? "Not paid this month." : "Processing on hold: this month's salary is paid as arrears once the hold is lifted."] };
    return { employeeId: p.id, salaryId: current.id, action, periodDays: period, payableDays: payable, lopDays, result: empty, context };
  }

  extras.push(...await arrearsFor(tx, run, d, shared));
  const st = d.statutory;
  const ptState = st.pt_state ?? st.location_state ?? null, lwfState = st.lwf_state ?? st.location_state ?? null;
  const rates = await ratesFor(tx, shared, M, ptState);
  const lwfRates = lwfState === ptState ? rates : await ratesFor(tx, shared, M, lwfState);
  const regime = st.tax_regime ?? "new";
  const esiWageOf = (b: Record<string, number>) => Object.entries(b).reduce((t, [c, v]) => { const m = metaFor(shared.components, c); return t + (m.kind !== "employer_contribution" && m.esiWage ? v : 0); }, 0);
  const taxableOf = (b: Record<string, number>) => Object.entries(b).reduce((t, [c, v]) => { const m = metaFor(shared.components, c); return t + (m.kind !== "employer_contribution" && m.taxable ? v : 0); }, 0);
  const coverage = inForce(d.salaries, esiCoverageMonth(M, p.joining_date, rates.esi.config)) ?? current;
  const hy = halfYear(M);
  const result = computeLine({
    month: M, periodDays: period, segments, components: shared.components, lopDays, extras, hasBank: p.has_bank,
    st: {
      pfEnabled: st.pf_enabled ?? true, pfOnFullWage: st.pf_on_full_wage ?? false, epsMember: epsMember(p.dob, M), esiEnabled: st.esi_enabled ?? true,
      pf: rates.pf.config, esi: rates.esi.config, pt: rates.pt?.config ?? null, lwf: lwfRates.lwf?.config ?? null, tax: rates.incomeTax[regime].config,
      regime, ageBand: ageBandFor(p.dob, M), gender: (p.gender === "female" || p.gender === "male" ? p.gender : null) as Gender, ptState,
      hasPan: p.has_pan, hasUan: !!st.uan, esiCoverageGrossPaise: esiWageOf(coverage.breakup),
      ytdPtPaise: d.ytd.pt, ytdTaxablePaise: d.ytd.taxable, ytdTdsPaise: d.ytd.tds, ptHalfGrossPaise: d.ytd.halfGross, ptMonthsLeftInHalf: hy.monthsLeft,
      recurringTaxablePaise: taxableOf(current.breakup), remainingMonths: remainingMonths(M, p.last_day),
      taxDeductions: await taxInputsFor(tx, p.id, fyRange(fyOf(M)).from), overrides,
    },
  });
  if (d.absentNoLop) result.warnings.push(`${d.absentNoLop} absent ${d.absentNoLop === 1 ? "day isn't" : "days aren't"} marked as loss of pay. Check attendance before you finalise.`);
  if (p.exit_status && p.last_day && p.last_day <= end) result.warnings.push(`Last working day ${p.last_day}: settle the rest in their full and final settlement.`);
  return { employeeId: p.id, salaryId: current.id, action, periodDays: period, payableDays: payable, lopDays, result, context };
}

// ---------------------------------------------------------------- the run

const BATCH = 50;

/**
 * Recalculate every line of a draft or in-progress run from scratch: deterministic and re-runnable (same data, same
 * lines). Works through people in batches; bumps the run's version (optimistic lock) and records that the lines
 * match that version, which finalising checks.
 */
export async function computeRun(tx: Tx, runId: string, opts: { expectedVersion?: number | null } = {}) {
  const run = await getRun(tx, runId, true);
  if (run.status !== "draft" && run.status !== "in_progress") throw new AppError("conflict", "This run is finalised. Roll it back before recalculating.");
  if (opts.expectedVersion != null && opts.expectedVersion !== run.lock_version) throw new AppError("conflict", "Someone else changed this run since you opened it. Reload the page to see their changes.");
  const [{ tenant_id }] = await tx<{ tenant_id: string }[]>`select tenant_id from payroll_runs where id = ${runId}`;
  const [prev] = await tx<{ status: string }[]>`select status from payroll_runs where pay_group_id = ${run.pay_group_id} and period_month = ${addMonths(run.period_month, -1)} and status <> 'rolled_back'`;
  const settled = await tx<{ employee_id: string }[]>`
    select employee_id from fnf_settlements where status = 'finalized' and settlement_month = ${run.period_month}
      and exists (select 1 from jsonb_array_elements(items) i where i->>'key' = 'salary' and i->>'action' in ('pay','paid_outside'))`;
  const shared: Shared = { components: await components(tx), rates: new Map(), prevLocked: !!prev && isLockedStatus(prev.status), tenantId: tenant_id, settledInFnf: new Set(settled.map((r) => r.employee_id)) };
  const people = await runPeople(tx, run.pay_group_id, run.period_month);
  await tx`delete from payroll_lines where run_id = ${runId}`;
  const totals: Required<Omit<RunTotals, "noSalary">> & { noSalary: { id: string; name: string }[] } =
    { headcount: 0, processed: 0, held: 0, gross: 0, deductions: 0, net: 0, employer: 0, cost: 0, warnings: 0, negative: 0, noSalary: [] };
  for (let i = 0; i < people.length; i += BATCH) {
    const batch = await loadPeople(tx, run, people.slice(i, i + BATCH));
    for (const d of batch) {
      const line = await draftLine(tx, run, d, shared);
      if (!line) { totals.noSalary.push({ id: d.person.id, name: d.person.name }); continue; }
      const r = line.result;
      await tx`
        insert into payroll_lines (tenant_id, run_id, employee_id, salary_id, period_days, payable_days, lop_days, earnings, deductions, employer, statutory,
          gross_paise, total_deductions_paise, net_paise, action, warnings)
        values (${tenant_id}, ${runId}, ${line.employeeId}, ${line.salaryId}, ${line.periodDays}, ${line.payableDays}, ${line.lopDays},
          ${tx.json(r.earnings as never)}, ${tx.json(r.deductions as never)}, ${tx.json(r.employer as never)}, ${tx.json({ ...r.statutory, context: line.context } as never)},
          ${r.grossPaise}, ${r.totalDeductionsPaise}, ${r.netPaise}, ${line.action}, ${r.warnings})`;
      totals.headcount++;
      if (line.action === "hold_processing" || line.action === "void") totals.held++; else totals.processed++;
      totals.gross += r.grossPaise; totals.deductions += r.totalDeductionsPaise; totals.net += r.netPaise;
      totals.employer += r.employer.reduce((t, e) => t + e.paise, 0);
      if (r.warnings.length) totals.warnings++;
      if (r.netPaise < 0) totals.negative++;
    }
  }
  totals.cost = totals.gross + totals.employer;
  const version = run.lock_version + 1;
  await tx`update payroll_runs set status = 'in_progress', totals = ${tx.json(totals as never)}, lock_version = ${version},
           step_state = ${tx.json({ ...run.step_state, computedVersion: version, computedAt: new Date().toISOString() } as never)}, updated_at = now()
           where id = ${runId}`;
  return { version, totals };
}
