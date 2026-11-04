/**
 * Payroll run rules: pure functions, no I/O and no clock. The service loads attendance, salaries, inputs and statutory
 * rates, and this file turns them into one employee's pay for one month. Golden tests in rules.test.ts.
 *
 * Money is integer paise. Rounding happens only here, and only in these places:
 *   1. A component paid for the whole month is paid exactly as the salary breakup says (it may carry paise).
 *   2. A component paid for part of a month (joining, leaving, loss of pay, a mid-month revision) is
 *      monthly × payable days ÷ period days, worked out exactly and rounded half-up to a whole rupee once.
 *   3. Day-based amounts (LOP adjustments and reversals, leave encashment, notice recovery) are rounded half-up to a rupee.
 *   4. PF, ESI, PT, LWF and TDS are rounded by the statutory engine (statutory/rules.ts), not here.
 *   5. Net pay = gross earnings − deductions, in paise; it is not rounded further.
 * Every statutory figure comes from statutory_rates, which a CA has NOT verified. See statutory/rates-data.ts.
 */
import { esi, fyOf, lwf, pf, professionalTax, projectTds, remainingMonthsInFy, type Gender } from "@/server/modules/statutory/rules";
import type { AgeBand, EsiConfig, IncomeTaxConfig, LwfConfig, PfConfig, PtConfig } from "@/server/modules/statutory/config";
import type { TaxDeductions } from "@/server/modules/statutory/rules";

export type ISODate = string;
const B = BigInt;

// ---------------------------------------------------------------- dates and months

export const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(s);
export const daysInMonth = (month: ISODate) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
export const monthEnd = (month: ISODate) => `${month.slice(0, 8)}${String(daysInMonth(month)).padStart(2, "0")}`;
export const monthStart = (date: ISODate) => `${date.slice(0, 7)}-01`;
export function addMonths(month: ISODate, n: number): ISODate {
  const t = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  const y = Math.floor(t / 12), m = t - y * 12 + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}
export const monthsBetween = (a: ISODate, b: ISODate) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
const addDays = (d: ISODate, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export function eachDate(from: ISODate, to: ISODate) { const out: ISODate[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthLabel = (month: ISODate) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
export const shortMonth = (month: ISODate) => `${MONTHS[Number(month.slice(5, 7)) - 1].slice(0, 3)} ${month.slice(2, 4)}`;

/**
 * The attendance windows a month's run uses, with a cut-off day C (pay_groups.attendance_cutoff_day):
 * loss of pay dated 1st…C of the month is paid (deducted) in that month; LOP dated after C rolls into next month's run,
 * valued at that earlier month's rate. A cut-off on or after the last day means the whole month counts now.
 */
export function attendanceWindows(month: ISODate, cutoffDay: number) {
  const end = monthEnd(month), days = daysInMonth(month);
  const current = { from: month, to: cutoffDay >= days ? end : `${month.slice(0, 8)}${String(cutoffDay).padStart(2, "0")}` };
  const prev = addMonths(month, -1), prevDays = daysInMonth(prev);
  const rolled = cutoffDay >= prevDays ? null : { month: prev, from: `${prev.slice(0, 8)}${String(cutoffDay + 1).padStart(2, "0")}`, to: monthEnd(prev) };
  return { current, rolled, lateFrom: current.to < end ? addDays(current.to, 1) : null };
}

export type Basis = "calendar" | "fixed_30" | "working";

/** Days a month is paid over: calendar days, a flat 30, or the person's working days. */
export function periodDays(month: ISODate, basis: Basis, workingDates?: Set<ISODate>) {
  if (basis === "fixed_30") return 30;
  if (basis === "working") return eachDate(month, monthEnd(month)).filter((d) => workingDates?.has(d) ?? true).length;
  return daysInMonth(month);
}

/** Days employed between two dates of one month, counted on the pay group's basis (fixed_30: a whole month is 30). */
export function countDays(month: ISODate, from: ISODate, to: ISODate, basis: Basis, workingDates?: Set<ISODate>) {
  if (to < from) return 0;
  const dates = eachDate(from, to);
  if (basis === "working") return dates.filter((d) => workingDates?.has(d) ?? true).length;
  if (basis === "fixed_30" && from === month && to === monthEnd(month)) return 30;
  return basis === "fixed_30" ? Math.min(30, dates.length) : dates.length;
}

// ---------------------------------------------------------------- segments and proration

export type ComponentMeta = {
  code: string; name: string; kind: string; taxable: boolean; lopProrated: boolean; pfWage: boolean; esiWage: boolean; inArrears: boolean; onPayslip: boolean;
  /** display order (payslips list earnings in this order; ties by code) */
  rank?: number;
};
const byRank = (components: Record<string, ComponentMeta>) => (a: string, b: string) =>
  (components[a]?.rank ?? 999) - (components[b]?.rank ?? 999) || (a < b ? -1 : a > b ? 1 : 0);
/** Defaults for a breakup code with no component row (e.g. one deleted later): a taxable, prorated earning. */
export const metaFor = (components: Record<string, ComponentMeta>, code: string): ComponentMeta =>
  components[code] ?? { code, name: code, kind: "earning", taxable: true, lopProrated: true, pfWage: false, esiWage: true, inArrears: true, onPayslip: true };

/** Part of a month paid on one salary: employed days (on the basis) and how many of them are payable after LOP. */
export type Segment = { salaryId: string; breakup: Record<string, number>; from: ISODate; to: ISODate; employedDays: number; payableDays: number };

/**
 * Split a month into the stretches each salary was in force, between the employed dates. `salaries` are the
 * person's salary records (any order); each runs from its effective date to the day before the next one.
 * LOP (dated) is charged to the segment its date falls in; undated LOP (manual adjustments) to the last segment.
 * fixed_30: a person employed all month gets 30 days in total, the last segment absorbing the difference.
 */
export function buildSegments(a: {
  month: ISODate; basis: Basis; workingDates?: Set<ISODate>; employedFrom: ISODate; employedTo: ISODate;
  salaries: { id: string; effectiveFrom: ISODate; breakup: Record<string, number> }[];
  lopByDate: Record<ISODate, number>; undatedLop: number;
}): Segment[] {
  const sorted = [...a.salaries].sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? -1 : 1));
  const segs: Segment[] = [];
  for (const [i, s] of sorted.entries()) {
    const next = sorted[i + 1];
    const from = s.effectiveFrom > a.employedFrom ? s.effectiveFrom : a.employedFrom;
    const end = next ? addDays(next.effectiveFrom, -1) : a.employedTo;
    const to = end < a.employedTo ? end : a.employedTo;
    if (to < from) continue;
    const dates = eachDate(from, to);
    let employed = a.basis === "working" ? dates.filter((d) => a.workingDates?.has(d) ?? true).length : dates.length;
    if (a.basis === "fixed_30") employed = Math.min(30, employed);
    const lop = dates.reduce((t, d) => t + (a.lopByDate[d] ?? 0), 0);
    segs.push({ salaryId: s.id, breakup: s.breakup, from, to, employedDays: employed, payableDays: Math.max(0, employed - lop) });
  }
  if (a.basis === "fixed_30" && segs.length && a.employedFrom === a.month && a.employedTo === monthEnd(a.month)) {
    const others = segs.slice(0, -1).reduce((t, s) => t + s.employedDays, 0);
    const last = segs[segs.length - 1];
    const lop = last.employedDays - last.payableDays;
    last.employedDays = Math.max(0, 30 - others);
    last.payableDays = Math.max(0, last.employedDays - lop);
  }
  if (a.undatedLop && segs.length) {
    const last = segs[segs.length - 1];
    last.payableDays = Math.min(last.employedDays, Math.max(0, last.payableDays - a.undatedLop));
  }
  return segs;
}

/** Hundredths of a day, so half and quarter days stay exact in integer maths. */
const D = (days: number) => B(Math.round(days * 100));
function divRound(n: bigint, d: bigint) {   // half away from zero
  const neg = (n < B(0)) !== (d < B(0));
  const an = n < B(0) ? -n : n, ad = d < B(0) ? -d : d;
  const q = (B(2) * an + ad) / (B(2) * ad);
  return neg ? -q : q;
}
/** Exact paise → nearest whole rupee (half up). */
export const toRupee = (n: bigint, d: bigint) => Number(divRound(n, d * B(100)) * B(100));

/**
 * One component's pay for the month. Whole month on one salary → exactly the breakup amount; otherwise
 * Σ monthly × days ÷ period days, rounded once to the rupee. `lop` false = not reduced by loss of pay.
 */
export function prorate(code: string, segments: Segment[], period: number, lop: boolean) {
  const full = segments.length === 1 && (lop ? segments[0].payableDays : segments[0].employedDays) === period;
  if (full) return segments[0].breakup[code] ?? 0;
  let n = B(0);
  for (const s of segments) n += B(s.breakup[code] ?? 0) * D(lop ? s.payableDays : s.employedDays);
  return toRupee(n, D(period));
}

/** Per-component value of some days at a month's rate (for LOP adjustments, reversals and recoveries), rupee-rounded. */
export function valueDays(breakup: Record<string, number>, components: Record<string, ComponentMeta>, days: number, period: number, onlyLop = true) {
  const out: Record<string, number> = {};
  for (const [code, monthly] of Object.entries(breakup)) {
    const m = metaFor(components, code);
    if (m.kind === "employer_contribution" || (onlyLop && !m.lopProrated)) continue;
    const v = toRupee(B(monthly) * D(days), D(period));
    if (v) out[code] = v;
  }
  return out;
}

// ---------------------------------------------------------------- the line

export type PayItem = {
  code: string; label: string; paise: number;
  /** salary = from the structure; arrear / lop = adjustments for earlier months; input = from payroll inputs; statutory = engine */
  kind: "salary" | "arrear" | "lop" | "input" | "reimbursement" | "statutory" | "employer";
  taxable?: boolean; sourceMonth?: string; inputId?: string; note?: string;
  /** LOP items: days of loss of pay this adds (negative when it gives days back) */
  days?: number;
};
/** An earning or deduction from outside the structure (inputs, arrears, LOP adjustments), already valued. Signed for earnings. */
export type ExtraItem = PayItem & { side: "earning" | "deduction"; taxable: boolean; pfWage: boolean; esiWage: boolean };

export type StatutoryOverrides = Partial<Record<"PF_EMPLOYEE" | "ESI" | "PT" | "LWF" | "TDS", number>>;
export type LineInput = {
  month: ISODate; periodDays: number; segments: Segment[]; components: Record<string, ComponentMeta>;
  /** LOP days in this month's window plus manual adjustments (for display) */
  lopDays: number;
  extras: ExtraItem[];
  /** daily-wage / piece-rate workers: the breakup holds rates per unit and pay is rate × units entered for the month (no attendance proration) */
  units?: { count: number; kind: "daily" | "piece" } | null;
  st: {
    pfEnabled: boolean; pfOnFullWage: boolean; epsMember: boolean; esiEnabled: boolean;
    pf: PfConfig | null; esi: EsiConfig | null; pt: PtConfig | null; lwf: LwfConfig | null; tax: IncomeTaxConfig | null;
    regime: "old" | "new"; ageBand: AgeBand; gender: Gender; ptState: string | null; hasPan: boolean; hasUan: boolean;
    /** full-month ESI wages in the month that decides coverage (null = this month's) */
    esiCoverageGrossPaise: number | null;
    ytdPtPaise: number; ytdTaxablePaise: number; ytdTdsPaise: number;
    /** half-yearly PT states: PT gross already paid in this half year, and months left in it including this one */
    ptHalfGrossPaise?: number; ptMonthsLeftInHalf?: number;
    /** taxable salary expected in each later month of the year (full month, current salary) */
    recurringTaxablePaise: number;
    /** months left in the financial year including this one, cut short when the person leaves */
    remainingMonths: number;
    /** from a submitted tax declaration (null = none: standard deduction only) */
    taxDeductions?: TaxDeductions | null;
    /** with a declaration: income and TDS from a previous employer this year, other declared income, PF and PT already paid here this year */
    taxExtra?: TaxExtra | null;
    overrides: StatutoryOverrides;
  };
  hasBank: boolean;
};

export type TaxExtra = {
  previousIncomePaise: number; previousTdsPaise: number; previousPfPaise: number; previousPtPaise: number;
  otherIncomePaise: number; ytdEmployeePfPaise: number;
};

/**
 * Declared deductions plus what payroll itself knows: employee PF (80C) and professional tax (section 16(iii)) for the
 * whole year: paid so far, this month, and this month's amount again for each month left. Previous employer PF and PT count too.
 */
export function declaredDeductions(base: TaxDeductions, x: TaxExtra | null | undefined, now: { pfPaise: number; ptPaise: number; ytdPtPaise: number; monthsLeft: number }): TaxDeductions {
  const e = x ?? { previousIncomePaise: 0, previousTdsPaise: 0, previousPfPaise: 0, previousPtPaise: 0, otherIncomePaise: 0, ytdEmployeePfPaise: 0 };
  const months = Math.max(1, now.monthsLeft);
  return {
    ...base,
    section80CPaise: (base.section80CPaise ?? 0) + e.previousPfPaise + e.ytdEmployeePfPaise + now.pfPaise * months,
    professionalTaxPaise: (base.professionalTaxPaise ?? 0) + e.previousPtPaise + now.ytdPtPaise + now.ptPaise * months,
  };
}

export type StatutoryDetail = {
  pf: { enabled: boolean; wagePaise: number; employeePaise: number; employerPaise: number; epsPaise: number; epfPaise: number; edliPaise: number; adminPaise: number; epsWagePaise: number; edliWagePaise: number } | null;
  esi: { covered: boolean; wagePaise: number; employeePaise: number; employerPaise: number } | null;
  pt: { state: string | null; grossPaise: number; amountPaise: number; due: boolean } | null;
  lwf: { employeePaise: number; employerPaise: number } | null;
  tds: { fy: string; regime: "old" | "new"; annualIncomePaise: number; annualTaxPaise: number; ytdTdsPaise: number; remainingMonths: number; monthlyPaise: number; standardDeductionOnly: boolean } | null;
  taxablePaise: number;
  overrides: StatutoryOverrides;
  /** Labour Codes: wages (basic + DA + retaining allowance) must be at least half of total remuneration */
  labourCode?: LabourCodeCheck;
};
export type LineResult = {
  earnings: PayItem[]; deductions: PayItem[]; employer: PayItem[]; statutory: StatutoryDetail;
  grossPaise: number; totalDeductionsPaise: number; netPaise: number; payableDays: number; employedDays: number; warnings: string[];
};

const sum = (xs: { paise: number }[]) => xs.reduce((t, x) => t + x.paise, 0);
const nonneg = (n: number) => Math.max(0, n);

/** One person's pay for the month. Deterministic: same input, same output. */
export function computeLine(i: LineInput): LineResult {
  const warnings: string[] = [];
  const codes: string[] = [];
  for (const s of i.segments) for (const c of Object.keys(s.breakup)) if (!codes.includes(c)) codes.push(c);
  codes.sort(byRank(i.components));
  const earnings: PayItem[] = [], employer: PayItem[] = [], deductions: PayItem[] = [];
  let pfWage = 0, esiWage = 0, taxable = 0;
  const unitRate = i.units ? unitRates(i.segments) : null;
  for (const code of codes) {
    const m = metaFor(i.components, code);
    const paise = unitRate ? unitPay(unitRate[code] ?? 0, i.units!.count) : prorate(code, i.segments, i.periodDays, m.lopProrated);
    if (m.kind === "employer_contribution") {
      // PF's employer share is worked out by the statutory engine below; other employer lines are paid as structured
      if (code !== "PF_EMPLOYER" && paise) employer.push({ code, label: m.name, paise, kind: "employer" });
      continue;
    }
    earnings.push({ code, label: m.name, paise, kind: m.kind === "reimbursable" ? "reimbursement" : "salary", taxable: m.taxable });
    if (m.pfWage) pfWage += paise;
    if (m.esiWage) esiWage += paise;
    if (m.taxable) taxable += paise;
  }
  for (const x of i.extras) {
    const item: PayItem = { code: x.code, label: x.label, paise: x.paise, kind: x.kind, taxable: x.taxable, sourceMonth: x.sourceMonth, inputId: x.inputId, note: x.note, days: x.days };
    if (x.side === "deduction") { deductions.push(item); continue; }
    earnings.push(item);
    if (x.pfWage) pfWage += x.paise;
    if (x.esiWage) esiWage += x.paise;
    if (x.taxable) taxable += x.paise;
  }
  pfWage = nonneg(pfWage); esiWage = nonneg(esiWage); taxable = nonneg(taxable);
  const gross = sum(earnings);
  const ov = i.st.overrides;
  const labourCode = labourCodeCheck(earnings);
  const statutory: StatutoryDetail = { pf: null, esi: null, pt: null, lwf: null, tds: null, taxablePaise: taxable, overrides: ov, labourCode };
  if (i.units && i.units.count <= 0) warnings.push(`No payable ${i.units.kind === "piece" ? "pieces" : "days"} were entered for this ${i.units.kind === "piece" ? "piece-rate" : "daily-wage"} worker, so nothing is paid this month.`);
  if (!labourCode.ok) warnings.push(`Labour Codes check: wages (basic, DA, retaining allowance) are ${labourCode.pct}% of remuneration, below the 50% the Code on Wages expects. ${inr(labourCode.shortfallPaise)} more would need to be wages.`);
  const month = Number(i.month.slice(5, 7));

  // PF
  if (i.st.pfEnabled && i.st.pf) {
    const r = pf({ config: i.st.pf, pfWagePaise: pfWage, fullWage: i.st.pfOnFullWage, epsMember: i.st.epsMember });
    const ee = ov.PF_EMPLOYEE ?? r.employeePaise;
    statutory.pf = { enabled: true, wagePaise: r.wagePaise, employeePaise: ee, employerPaise: r.employerPaise, epsPaise: r.employerEpsPaise, epfPaise: r.employerEpfPaise, edliPaise: r.edliPaise, adminPaise: r.adminChargePaise, epsWagePaise: r.epsWagePaise, edliWagePaise: r.edliWagePaise };
    if (ee) deductions.push({ code: "PF_EMPLOYEE", label: "Provident fund", paise: ee, kind: "statutory" });
    if (r.employerPaise) employer.push({ code: "PF_EMPLOYER", label: "PF (employer share)", paise: r.employerPaise, kind: "employer" });
    if (!i.st.hasUan && pfWage > 0) warnings.push("PF is deducted but there's no UAN on file.");
  }
  // ESI
  if (i.st.esiEnabled && i.st.esi) {
    const r = esi({ config: i.st.esi, grossPaise: esiWage, coverageGrossPaise: i.st.esiCoverageGrossPaise });
    const ee = ov.ESI ?? r.employeePaise;
    statutory.esi = { covered: r.covered && esiWage > 0, wagePaise: esiWage, employeePaise: ee, employerPaise: r.employerPaise };
    if (ee) deductions.push({ code: "ESI", label: "ESI", paise: ee, kind: "statutory" });
    if (r.employerPaise) employer.push({ code: "ESI_EMPLOYER", label: "ESI (employer share)", paise: r.employerPaise, kind: "employer" });
  }
  // Professional tax (on taxable gross)
  if (i.st.pt) {
    const r = professionalTax({ config: i.st.pt, month, grossPaise: taxable, gender: i.st.gender, ytdPaise: i.st.ytdPtPaise,
      periodGrossPaise: i.st.pt.period === "half_yearly" ? (i.st.ptHalfGrossPaise ?? 0) + taxable * (i.st.ptMonthsLeftInHalf ?? 1) : null });
    const amt = ov.PT ?? r.amountPaise;
    statutory.pt = { state: i.st.ptState, grossPaise: taxable, amountPaise: amt, due: r.dueThisMonth };
    if (amt) deductions.push({ code: "PT", label: "Professional tax", paise: amt, kind: "statutory" });
  } else {
    statutory.pt = { state: i.st.ptState, grossPaise: taxable, amountPaise: ov.PT ?? 0, due: false };
    if (ov.PT) deductions.push({ code: "PT", label: "Professional tax", paise: ov.PT, kind: "statutory" });
    if (!i.st.ptState) warnings.push("No professional tax state: set one on the person's work location or statutory details.");
  }
  // LWF (on gross)
  if (i.st.lwf) {
    const r = lwf({ config: i.st.lwf, month, grossPaise: nonneg(gross) });
    const ee = ov.LWF ?? r.employeePaise;
    statutory.lwf = { employeePaise: ee, employerPaise: r.employerPaise };
    if (ee) deductions.push({ code: "LWF", label: "Labour welfare fund", paise: ee, kind: "statutory" });
    if (r.employerPaise) employer.push({ code: "LWF_EMPLOYER", label: "LWF (employer share)", paise: r.employerPaise, kind: "employer" });
  }
  // TDS: projected annual tax less TDS so far, spread over the months left (standard deduction only unless declarations exist)
  if (i.st.tax) {
    const fy = fyOf(i.month);
    const months = Math.min(12, Math.max(1, i.st.remainingMonths));
    const td = i.st.taxDeductions, x = td ? i.st.taxExtra ?? null : null;
    const deds = td ? declaredDeductions(td, x, { pfPaise: statutory.pf?.employeePaise ?? 0, ptPaise: statutory.pt?.amountPaise ?? 0, ytdPtPaise: i.st.ytdPtPaise, monthsLeft: months }) : undefined;
    const r = projectTds({ fy, regime: i.st.regime, config: i.st.tax, ytdTaxablePaise: i.st.ytdTaxablePaise + (x ? x.previousIncomePaise + x.otherIncomePaise : 0),
      projectedTaxablePaise: taxable + i.st.recurringTaxablePaise * (months - 1), deductions: deds,
      tdsDeductedPaise: i.st.ytdTdsPaise + (x?.previousTdsPaise ?? 0), remainingMonths: months, ageBand: i.st.ageBand });
    // never more than what's left of this month's pay: the rest falls into the months ahead, since each month recomputes
    const room = nonneg(gross - sum(deductions));
    const amt = ov.TDS ?? Math.min(r.monthlyTdsPaise, room);
    if (ov.TDS == null && amt < r.monthlyTdsPaise) warnings.push("Income tax is limited to this month's pay; the rest is spread over the coming months.");
    statutory.tds = { fy, regime: i.st.regime, annualIncomePaise: r.annualIncomePaise, annualTaxPaise: r.annual.totalTaxPaise, ytdTdsPaise: i.st.ytdTdsPaise, remainingMonths: months, monthlyPaise: amt, standardDeductionOnly: !i.st.taxDeductions };
    if (amt) deductions.push({ code: "TDS", label: "Income tax (TDS)", paise: amt, kind: "statutory" });
    if (amt > 0 && !i.st.hasPan) warnings.push("No PAN on file. The law expects TDS at a higher rate without a PAN; erp hasn't applied that, so check with your CA.");
  } else if (taxable > 0) {
    warnings.push(`No income tax rates are set up for FY ${fyOf(i.month)}, so no TDS was worked out.`);
  }
  const totalDeductions = sum(deductions);
  const net = gross - totalDeductions;
  if (net < 0) warnings.push("Net pay is negative: deductions are more than earnings this month.");
  if (!i.hasBank && net > 0) warnings.push("No bank account on file, so this person can't be included in a bank transfer file.");
  return {
    earnings, deductions, employer, statutory, grossPaise: gross, totalDeductionsPaise: totalDeductions, netPaise: net,
    payableDays: i.units ? i.units.count : i.segments.reduce((t, s) => t + s.payableDays, 0), employedDays: i.units ? i.units.count : i.segments.reduce((t, s) => t + s.employedDays, 0), warnings,
  };
}

// ---------------------------------------------------------------- daily wages and piece rate

export const UNIT_WORKER_TYPES = ["daily", "piece"] as const;
export const isUnitWorker = (workerType: string | null | undefined): workerType is "daily" | "piece" => workerType === "daily" || workerType === "piece";
/** The rates in force at the end of the month (the last segment's breakup): rate per day or per piece. */
export function unitRates(segments: Segment[]): Record<string, number> {
  return segments.length ? segments[segments.length - 1].breakup : {};
}
/** rate × units, rounded half-up to a rupee (units may carry halves or hundredths). */
export const unitPay = (ratePaise: number, units: number) => toRupee(B(ratePaise) * D(units), D(1));

// ---------------------------------------------------------------- Labour Codes: the 50% wages rule

/** Codes that count as "wages" under the Code on Wages (basic, dearness allowance, retaining allowance). */
export const WAGE_CODES = ["BASIC", "DA", "RETAINING_ALLOWANCE", "RETAINING"] as const;
export type LabourCodeCheck = { wagesPaise: number; remunerationPaise: number; requiredPaise: number; shortfallPaise: number; pct: number | null; ok: boolean };
/**
 * The Code on Wages, 2019 counts the excluded allowances only up to half of total remuneration: if they are more, the
 * excess is treated as wages. In practice: basic + DA + retaining allowance should be at least 50% of remuneration.
 * Remuneration here is everything paid as salary this month (arrears and LOP adjustments included); reimbursements
 * and employer contributions aren't remuneration. An advisory check only; erp doesn't change the pay.
 */
export function labourCodeCheck(earnings: PayItem[], wageCodes: readonly string[] = WAGE_CODES): LabourCodeCheck {
  const base = (c: string) => c.replace(/^(ARR|LOP)_/, "");
  const counted = earnings.filter((e) => e.kind !== "reimbursement");
  const remunerationPaise = Math.max(0, sum(counted));
  const wagesPaise = Math.max(0, sum(counted.filter((e) => wageCodes.includes(base(e.code)))));
  const requiredPaise = Math.ceil(remunerationPaise / 2);
  const shortfallPaise = Math.max(0, requiredPaise - wagesPaise);
  const pct = remunerationPaise > 0 ? Math.round((wagesPaise * 1000) / remunerationPaise) / 10 : null;
  return { wagesPaise, remunerationPaise, requiredPaise, shortfallPaise, pct, ok: remunerationPaise <= 0 || wagesPaise * 2 >= remunerationPaise };
}

// ---------------------------------------------------------------- statutory helpers

/** Age band for the financial year containing `month` (age reached by 31 March). */
export function ageBandFor(dob: ISODate | null, month: ISODate): AgeBand {
  if (!dob) return "below_60";
  const fyEnd = `${Number(fyOf(month).slice(0, 4)) + 1}-03-31`;
  let age = Number(fyEnd.slice(0, 4)) - Number(dob.slice(0, 4));
  if (fyEnd.slice(5) < dob.slice(5)) age--;
  return age >= 80 ? "super_senior" : age >= 60 ? "senior" : "below_60";
}
/** Members stop contributing to the pension scheme (EPS) at 58. */
export function epsMember(dob: ISODate | null, month: ISODate) {
  if (!dob) return true;
  const at58 = `${Number(dob.slice(0, 4)) + 58}${dob.slice(4)}`;
  return at58 > monthEnd(month);
}
/** Months left in the financial year including this one, ending early in the month someone leaves. */
export function remainingMonths(month: ISODate, lastDay: ISODate | null) {
  const fy = remainingMonthsInFy(month);
  if (!lastDay) return fy;
  return Math.max(1, Math.min(fy, monthsBetween(month, monthStart(lastDay)) + 1));
}
/** The half-year (Apr–Sep / Oct–Mar) a month is in, and the months left in it including this one. */
export function halfYear(month: ISODate) {
  const m = Number(month.slice(5, 7)), y = Number(month.slice(0, 4));
  const start = m >= 4 && m <= 9 ? `${y}-04-01` : m >= 10 ? `${y}-10-01` : `${y - 1}-10-01`;
  return { start, monthsLeft: 6 - monthsBetween(start, month) };
}

// ---------------------------------------------------------------- arrears

/**
 * Arrears for months already paid: what the current salary records say each component should have been for that
 * month's payable days, minus everything already paid for that month and component (the month's own line plus any
 * arrears paid since). Only components marked "in arrears". Negative differences (a salary cut back-dated) are kept,
 * so they recover what was overpaid.
 */
export function arrearsDue(months: { month: ISODate; expected: Record<string, number>; paid: Record<string, number> }[], components: Record<string, ComponentMeta>): ExtraItem[] {
  const out: ExtraItem[] = [];
  for (const m of months) {
    for (const code of [...new Set([...Object.keys(m.expected), ...Object.keys(m.paid)])].sort(byRank(components))) {
      const meta = metaFor(components, code);
      if (!meta.inArrears || meta.kind === "employer_contribution") continue;
      const diff = (m.expected[code] ?? 0) - (m.paid[code] ?? 0);
      if (!diff) continue;
      out.push({ code: `ARR_${code}`, label: `Arrears: ${meta.name} (${shortMonth(m.month)})`, paise: diff, kind: "arrear", side: "earning", sourceMonth: m.month,
        taxable: meta.taxable, pfWage: meta.pfWage, esiWage: meta.esiWage });
    }
  }
  return out;
}

// ---------------------------------------------------------------- variance, words, files

/** Change against last month, as a whole-number percentage (null when there's nothing to compare with). */
export function variancePct(current: number, previous: number | null | undefined) {
  if (previous == null || previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function under100(n: number) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`; }
function under1000(n: number) { const h = Math.floor(n / 100), r = n % 100; return [h ? `${ONES[h]} Hundred` : "", r ? under100(r) : ""].filter(Boolean).join(" "); }
/** Whole number in words with Indian grouping (thousand, lakh, crore). */
export function indianWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("indianWords takes a whole, non-negative number");
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 1_00_00_000);
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  let r = n % 1_00_00_000;
  const lakh = Math.floor(r / 1_00_000); r %= 1_00_000;
  const thousand = Math.floor(r / 1000); r %= 1000;
  if (lakh) parts.push(`${under100(lakh)} Lakh`);
  if (thousand) parts.push(`${under100(thousand)} Thousand`);
  if (r) parts.push(under1000(r));
  return parts.join(" ");
}
/** "Rupees Twelve Thousand Three Hundred and Forty Five Paise Only". Negative amounts are prefixed with "Minus". */
export function amountInWords(paise: number) {
  const neg = paise < 0, a = Math.abs(paise);
  const rupees = Math.floor(a / 100), p = a % 100;
  return `${neg ? "Minus " : ""}Rupees ${indianWords(rupees)}${p ? ` and ${under100(p)} Paise` : ""} Only`;
}
/** ₹1,23,456.78 style, for files and PDFs (Indian grouping, two decimals). */
export function inr(paise: number, symbol = "Rs. ") {
  const neg = paise < 0, a = Math.abs(paise);
  const r = String(Math.floor(a / 100)), p = String(a % 100).padStart(2, "0");
  const last3 = r.slice(-3), rest = r.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${neg ? "-" : ""}${symbol}${grouped}.${p}`;
}
/** Plain decimal rupees for CSV/XLSX cells ("12345.60"). */
export const rupees = (paise: number) => `${paise < 0 ? "-" : ""}${Math.floor(Math.abs(paise) / 100)}.${String(Math.abs(paise) % 100).padStart(2, "0")}`;

export function csv(rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;   // no spreadsheet formulas
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export type BankRow = { employeeNumber: string; name: string; holderName: string; accountNumber: string; ifsc: string; bankName: string; netPaise: number };
export const BANK_FORMATS = {
  neft_csv: { label: "Generic NEFT (CSV)", ext: "csv", mime: "text/csv" },
  hdfc_bulk: { label: "Bank bulk upload (pipe-separated)", ext: "txt", mime: "text/plain" },
} as const;
export type BankFormat = keyof typeof BANK_FORMATS;

/**
 * Bank transfer file. neft_csv: one header row and one row per person. hdfc_bulk: a pipe-separated layout in the
 * style many Indian banks accept for bulk salary uploads (transaction type N for NEFT, I when the IFSC is the
 * paying bank's own). Banks change these layouts; check against your bank's current template before uploading.
 */
export function bankFile(format: BankFormat, rows: BankRow[], a: { month: ISODate; debitAccount?: string | null; payerIfscPrefix?: string | null; valueDate: ISODate }) {
  const narration = `Salary ${shortMonth(a.month)}`;
  if (format === "neft_csv") {
    return csv([["Beneficiary name", "Account number", "IFSC", "Bank", "Amount", "Narration", "Employee number"],
      ...rows.map((r) => [r.holderName, r.accountNumber, r.ifsc, r.bankName, rupees(r.netPaise), narration, r.employeeNumber])]);
  }
  const d = a.valueDate.split("-").reverse().join("/");
  return rows.map((r) => [a.payerIfscPrefix && r.ifsc.startsWith(a.payerIfscPrefix) ? "I" : "N", r.employeeNumber, r.accountNumber, rupees(r.netPaise),
    r.holderName.replace(/\|/g, " ").slice(0, 40), "", "", "", "", "", "", "", "", narration, "", "", "", "", "", "", "", "", d, "", r.ifsc, r.bankName.replace(/\|/g, " "), "", ""].join("|")).join("\r\n") + "\r\n";
}

/**
 * EPFO electronic challan-cum-return (ECR) text: one line per member, fields joined with #~#:
 * UAN, name, gross wages, EPF wages, EPS wages, EDLI wages, EPF (employee), EPS (employer), EPF − EPS (employer), NCP days, refund.
 * Wages and contributions are whole rupees. The layout is as generally published; check against EPFO's current spec.
 */
export function ecrLine(r: { uan: string; name: string; grossPaise: number; epfWagePaise: number; epsWagePaise: number; edliWagePaise: number; employeePaise: number; epsPaise: number; epfPaise: number; ncpDays: number }) {
  const R = (p: number) => String(Math.round(p / 100));
  return [r.uan, r.name.toUpperCase().replace(/#~#/g, " "), R(r.grossPaise), R(r.epfWagePaise), R(r.epsWagePaise), R(r.edliWagePaise), R(r.employeePaise), R(r.epsPaise), R(r.epfPaise), String(Math.round(r.ncpDays)), "0"].join("#~#");
}

// ---------------------------------------------------------------- full and final settlement

export type FnfItem = {
  key: string; label: string; side: "earning" | "deduction"; paise: number;
  action: "pay" | "void" | "paid_outside"; auto: boolean; note?: string | null;
  /** periodic settlements: which part (1…n) pays this item; null = not placed yet */
  part?: number | null;
};
/** Net settlement: earnings to pay minus deductions to recover (void and paid-outside items don't count). */
export function fnfNet(items: FnfItem[]) {
  return items.filter((i) => i.action === "pay").reduce((t, i) => t + (i.side === "earning" ? i.paise : -i.paise), 0);
}
/** Notice days not served: required notice − days served − days waived (never negative). */
export function noticeShortfall(a: { resignationDate: ISODate; lastWorkingDate: ISODate; noticeDays: number; waivedDays: number }) {
  const served = Math.round((Date.parse(`${a.lastWorkingDate}T00:00:00Z`) - Date.parse(`${a.resignationDate}T00:00:00Z`)) / 864e5);
  return Math.max(0, a.noticeDays - served - a.waivedDays);
}
/** A day's pay for settlements: monthly amount ÷ 30, times the days, rounded to a rupee. */
export const dayRate = (monthlyPaise: number, days: number) => toRupee(B(monthlyPaise) * D(days), D(30));

// ---------------------------------------------------------------- run steps

export const STEPS = [
  { key: "attendance", title: "Attendance and loss of pay" },
  { key: "people", title: "Joiners, exits and pay actions" },
  { key: "variable", title: "Bonus, revisions and overtime" },
  { key: "claims", title: "Claims, payments and deductions" },
  { key: "holds", title: "Holds and arrears" },
  { key: "review", title: "Statutory and summary" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export const RUN_STATUS_LABEL: Record<string, string> = {
  draft: "Not started", in_progress: "In progress", finalized: "Finalised", payslips_released: "Payslips released", paid: "Paid", rolled_back: "Rolled back",
};
export const LINE_ACTIONS = ["process", "hold_processing", "hold_payout", "void", "paid_outside"] as const;
export type LineAction = (typeof LINE_ACTIONS)[number];
export const LINE_ACTION_LABEL: Record<LineAction, string> = {
  process: "Process", hold_processing: "Hold processing", hold_payout: "Hold payout", void: "Don't pay this month", paid_outside: "Paid outside erp",
};
/** Lines whose pay goes in a bank file. */
export const bankable = (action: string, netPaise: number) => action === "process" && netPaise > 0;
/** Lines that get a payslip. */
export const slipped = (action: string) => action === "process" || action === "hold_payout" || action === "paid_outside";
/** Whether a status counts as "this month's payroll is done" for locking and later arrears. */
export const isLockedStatus = (s: string) => s === "finalized" || s === "payslips_released" || s === "paid";
