/**
 * Statutory engine: PF, ESI, professional tax, LWF, gratuity, income tax and monthly TDS.
 * Pure functions (no I/O, no clock): every rate comes in as a validated config from statutory_rates.
 *
 * Money is integer paise in and out. Percentages are applied with exact integer maths (BigInt) and rounded once,
 * where the rule says: PF to the nearest rupee, ESI up to the next rupee, taxable income and tax to the nearest ₹10,
 * monthly TDS to the nearest rupee. Nothing here has been checked by a CA — see rates-data.ts.
 */
import type { AgeBand, EsiConfig, GratuityConfig, IncomeTaxConfig, LwfConfig, PfConfig, PtConfig, PtSlab, TaxSlab } from "./config";

// ---------------------------------------------------------------- integer helpers
type Rounding = "half_up" | "up" | "down";
const B1 = BigInt(1), B2 = BigInt(2), B10K = BigInt(10_000);

function money(name: string, v: number) {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a whole, non-negative number of paise (got ${v})`);
  return v;
}

function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  if (mode === "down") return n / d;
  if (mode === "up") return (n + d - B1) / d;
  return (B2 * n + d) / (B2 * d);
}

/** amount × bp / 10000, rounded to a multiple of `unit` paise. */
export function applyBp(amountPaise: number, bp: number, unit = 1, mode: Rounding = "half_up"): number {
  return Number(divRound(BigInt(amountPaise) * BigInt(bp), B10K * BigInt(unit), mode) * BigInt(unit));
}

/** Round paise to a multiple of `unit` paise (100 = rupee, 1000 = ₹10). */
export function roundPaise(paise: number, unit: number, mode: Rounding = "half_up"): number {
  return Number(divRound(BigInt(paise), BigInt(unit), mode) * BigInt(unit));
}

const RUPEE = 100;
const TEN_RUPEES = 1_000;

// ---------------------------------------------------------------- dates (plain YYYY-MM-DD strings)
const ymd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return { y, m, d }; };
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function addMonths(s: string, n: number) {
  const { y, m, d } = ymd(s);
  const t = y * 12 + (m - 1) + n, ny = Math.floor(t / 12), nm = (t % 12) + 1;
  return iso(ny, nm, Math.min(d, daysIn(ny, nm)));
}
function addDays(s: string, n: number) {
  const { y, m, d } = ymd(s);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** "2025-26" for any date from 1 Apr 2025 to 31 Mar 2026. */
export function fyOf(date: string) {
  const { y, m } = ymd(date);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
export function fyRange(fy: string) {
  const start = Number(fy.slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}
/** Months left in the financial year counting the month of `date` itself: April → 12, March → 1. */
export function remainingMonthsInFy(date: string) {
  const { m } = ymd(date);
  return m >= 4 ? 16 - m : 4 - m;
}

// ---------------------------------------------------------------- PF
export type PfInput = {
  config: PfConfig;
  /** This month's PF wages (basic + DA and whatever the company treats as PF wages), after loss-of-pay. */
  pfWagePaise: number;
  /** The company contributes on full wages instead of capping at the wage ceiling (employee_statutory.pf_on_full_wage). */
  fullWage?: boolean;
  /** Member of the pension scheme. False for people who joined above the ceiling after Sept 2014, or are 58+. */
  epsMember?: boolean;
};
export type PfResult = {
  wagePaise: number; epsWagePaise: number; edliWagePaise: number;
  employeePaise: number; employerPaise: number; employerEpsPaise: number; employerEpfPaise: number;
  adminChargePaise: number; edliPaise: number;
};

export function pf({ config: c, pfWagePaise, fullWage = false, epsMember = true }: PfInput): PfResult {
  money("pfWagePaise", pfWagePaise);
  const capped = Math.min(pfWagePaise, c.wageCeilingPaise);
  const wagePaise = fullWage ? pfWagePaise : capped;
  const epsWagePaise = epsMember ? capped : 0;
  const edliWagePaise = Math.min(pfWagePaise, c.edliWageCeilingPaise);
  const employeePaise = applyBp(wagePaise, c.employeeBp, RUPEE);
  const employerPaise = applyBp(wagePaise, c.employerBp, RUPEE);
  const employerEpsPaise = Math.min(applyBp(epsWagePaise, c.epsBp, RUPEE), c.epsMaxPaise, employerPaise);
  return {
    wagePaise, epsWagePaise, edliWagePaise, employeePaise, employerPaise, employerEpsPaise,
    employerEpfPaise: employerPaise - employerEpsPaise,
    adminChargePaise: applyBp(wagePaise, c.adminChargeBp, RUPEE),
    edliPaise: applyBp(edliWagePaise, c.edliBp, RUPEE),
  };
}

// ---------------------------------------------------------------- ESI
/** The ESI contribution period (Apr–Sep or Oct–Mar) that contains `date`. */
export function esiPeriod(date: string, c: Pick<EsiConfig, "periodStartMonths"> = { periodStartMonths: [4, 10] }) {
  const { y, m } = ymd(date);
  const starts = [...c.periodStartMonths].sort((a, b) => a - b);
  // the latest start month at or before m (wrapping to last year's last start)
  const before = starts.filter((s) => s <= m);
  const startMonth = before.length ? before[before.length - 1] : starts[starts.length - 1];
  const startYear = before.length ? y : y - 1;
  const next = starts.find((s) => s > startMonth) ?? starts[0];
  const endYear = next > startMonth ? startYear : startYear + 1;
  const start = iso(startYear, startMonth, 1);
  const end = addDays(iso(endYear, next, 1), -1);
  return { start, end };
}

/**
 * Which month's wages decide ESI coverage for `date`: the first month of the contribution period,
 * or the joining month for someone who joined during the period.
 */
export function esiCoverageMonth(date: string, joiningDate: string | null, c?: Pick<EsiConfig, "periodStartMonths">) {
  const { start } = esiPeriod(date, c);
  if (!joiningDate) return start;
  const j = joiningDate.slice(0, 7) + "-01";
  return j > start ? j : start;
}

export type EsiInput = {
  config: EsiConfig;
  /** This month's gross wages (what contributions are charged on). */
  grossPaise: number;
  /**
   * Gross wages in the month that decides coverage (see esiCoverageMonth). Someone covered then stays covered —
   * on their actual wages — until the period ends, even after a raise. Defaults to this month's gross.
   */
  coverageGrossPaise?: number | null;
  disabled?: boolean;
  /** Average daily wage; at or below the exemption limit only the employer pays. */
  averageDailyWagePaise?: number | null;
};
export type EsiResult = { covered: boolean; ceilingPaise: number; employeePaise: number; employerPaise: number; employeeExempt: boolean };

export function esi({ config: c, grossPaise, coverageGrossPaise, disabled = false, averageDailyWagePaise }: EsiInput): EsiResult {
  money("grossPaise", grossPaise);
  const decider = coverageGrossPaise ?? grossPaise;
  money("coverageGrossPaise", decider);
  const ceilingPaise = disabled ? c.disabledWageCeilingPaise : c.wageCeilingPaise;
  const covered = decider <= ceilingPaise && grossPaise > 0;
  if (!covered) return { covered: decider <= ceilingPaise, ceilingPaise, employeePaise: 0, employerPaise: 0, employeeExempt: false };
  const employeeExempt = averageDailyWagePaise != null && averageDailyWagePaise <= c.employeeExemptDailyWagePaise;
  return {
    covered, ceilingPaise, employeeExempt,
    employeePaise: employeeExempt ? 0 : applyBp(grossPaise, c.employeeBp, RUPEE, "up"),
    employerPaise: applyBp(grossPaise, c.employerBp, RUPEE, "up"),
  };
}

// ---------------------------------------------------------------- Professional tax
export type Gender = "male" | "female" | "other" | null;
export type PtInput = {
  config: PtConfig;
  /** Calendar month being paid, 1–12 (February can carry a different amount). */
  month: number;
  grossPaise: number;
  gender?: Gender;
  /** PT already deducted this financial year (the yearly cap applies). */
  ytdPaise?: number;
  /** Half-yearly states: gross for the half year. Defaults to this month's gross × 6. */
  periodGrossPaise?: number | null;
};
export type PtResult = { amountPaise: number; slabAmountPaise: number; capped: boolean; dueThisMonth: boolean };

function findSlab<T extends { upToPaise: number | null }>(slabs: T[], amount: number): T {
  return slabs.find((s) => s.upToPaise == null || amount <= s.upToPaise) ?? slabs[slabs.length - 1];
}

export function professionalTax({ config: c, month, grossPaise, gender = null, ytdPaise = 0, periodGrossPaise }: PtInput): PtResult {
  money("grossPaise", grossPaise); money("ytdPaise", ytdPaise);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError("month must be 1–12");
  const table: PtSlab[] = gender === "female" && c.femaleSlabs ? c.femaleSlabs : c.slabs;
  let base = grossPaise;
  if (c.period === "half_yearly") {
    if (!(c.deductMonths ?? []).includes(month)) return { amountPaise: 0, slabAmountPaise: 0, capped: false, dueThisMonth: false };
    base = periodGrossPaise ?? grossPaise * 6;
    money("periodGrossPaise", base);
  }
  const slab = findSlab(table, base);
  const slabAmountPaise = month === 2 && slab.februaryAmountPaise != null ? slab.februaryAmountPaise : slab.amountPaise;
  const room = Math.max(0, c.annualCapPaise - ytdPaise);
  const amountPaise = Math.min(slabAmountPaise, room);
  return { amountPaise, slabAmountPaise, capped: amountPaise < slabAmountPaise, dueThisMonth: true };
}

// ---------------------------------------------------------------- LWF
export type LwfResult = { employeePaise: number; employerPaise: number; dueThisMonth: boolean };
export function lwf({ config: c, month, grossPaise }: { config: LwfConfig; month: number; grossPaise: number }): LwfResult {
  money("grossPaise", grossPaise);
  if (!c.deductMonths.includes(month) || grossPaise === 0) return { employeePaise: 0, employerPaise: 0, dueThisMonth: c.deductMonths.includes(month) };
  const s = findSlab(c.slabs, grossPaise);
  return { employeePaise: s.employeePaise, employerPaise: s.employerPaise, dueThisMonth: true };
}

// ---------------------------------------------------------------- Gratuity
export type ExitReason = "resignation" | "retirement" | "termination" | "death" | "disablement";
export type GratuityInput = {
  config: GratuityConfig;
  /** Last drawn monthly basic + DA. */
  lastMonthlyWagePaise: number;
  joiningDate: string;
  lastWorkingDate: string;
  reason?: ExitReason;
  fixedTerm?: boolean;
};
export type GratuityResult = {
  eligible: boolean; completedYears: number; extraMonths: number; countedYears: number;
  formulaPaise: number;   // 15/26 × wage × counted years, before the ceiling
  amountPaise: number;    // what the law requires (0 when not eligible), capped at the ceiling
  exemptPaise: number;    // tax-free part of amountPaise
};

/** Whole years and months of service from joining through the last working day (inclusive). */
export function serviceLength(joiningDate: string, lastWorkingDate: string) {
  if (lastWorkingDate < joiningDate) throw new RangeError("last working date is before joining");
  const end = addDays(lastWorkingDate, 1);
  const a = ymd(joiningDate), b = ymd(end);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (addMonths(joiningDate, months) > end) months--;
  const extraDays = Math.round((Date.parse(end) - Date.parse(addMonths(joiningDate, months))) / 86_400_000);
  return { years: Math.floor(months / 12), months: months % 12, days: extraDays };
}

export function gratuity({ config: c, lastMonthlyWagePaise, joiningDate, lastWorkingDate, reason = "resignation", fixedTerm = false }: GratuityInput): GratuityResult {
  money("lastMonthlyWagePaise", lastMonthlyWagePaise);
  const s = serviceLength(joiningDate, lastWorkingDate);
  const roundUp = s.months > c.roundUpAfterMonths || (s.months === c.roundUpAfterMonths && s.days > 0);
  const countedYears = s.years + (roundUp ? 1 : 0);
  const needs = reason === "death" || reason === "disablement" ? 0 : fixedTerm ? c.fixedTermMinYears : c.minYears;
  const eligible = s.years >= needs && countedYears > 0;
  const formulaPaise = Number(divRound(BigInt(lastMonthlyWagePaise) * BigInt(c.daysPerYear) * BigInt(countedYears), BigInt(c.monthDivisor) * BigInt(RUPEE), "half_up") * BigInt(RUPEE));
  const amountPaise = eligible ? Math.min(formulaPaise, c.exemptionCapPaise) : 0;
  return { eligible, completedYears: s.years, extraMonths: s.months, countedYears, formulaPaise, amountPaise, exemptPaise: amountPaise };
}

// ---------------------------------------------------------------- Income tax
export type TaxDeductions = {
  section80CPaise?: number;          // 80C/80CCC/80CCD(1), capped together
  otherChapterVIAPaise?: number;     // 80D, 80CCD(1B), 80E … (caps are the declaration module's job)
  hraExemptPaise?: number;           // already worked out by the HRA rules
  otherExemptionsPaise?: number;     // LTA and other salary exemptions
  professionalTaxPaise?: number;     // section 16(iii)
  homeLoanInterestPaise?: number;    // section 24(b), self-occupied
  employerNpsPaise?: number;         // 80CCD(2): allowed in both regimes
};
export type AnnualTaxInput = {
  config: IncomeTaxConfig;
  /** Gross taxable salary and other income for the year, before standard deduction and exemptions. */
  grossIncomePaise: number;
  deductions?: TaxDeductions;
  ageBand?: AgeBand;
  /** Salaried people get the standard deduction; turn off for non-salary income. */
  standardDeduction?: boolean;
};
export type AnnualTaxResult = {
  fy: string; regime: "old" | "new";
  grossIncomePaise: number; standardDeductionPaise: number; deductionsPaise: number; taxableIncomePaise: number;
  slabTaxPaise: number; rebatePaise: number; surchargePaise: number; cessPaise: number; totalTaxPaise: number;
};

/** Deductions that count in this regime, with the statutory caps applied. */
export function allowedDeductions(c: IncomeTaxConfig, d: TaxDeductions = {}) {
  const v = (k: keyof TaxDeductions) => money(k, d[k] ?? 0);
  if (c.deductions === "limited") return v("employerNpsPaise");
  return v("employerNpsPaise") + v("hraExemptPaise") + v("otherExemptionsPaise") + v("otherChapterVIAPaise")
    + Math.min(v("section80CPaise"), c.caps.section80CPaise)
    + Math.min(v("homeLoanInterestPaise"), c.caps.homeLoanInterestPaise)
    + Math.min(v("professionalTaxPaise"), c.caps.professionalTaxPaise);
}

/** Tax on `income` by slabs, exact, rounded to the paisa. */
export function slabTax(slabs: TaxSlab[], incomePaise: number) {
  let acc = BigInt(0), prev = 0;
  for (const s of slabs) {
    const top = s.upToPaise == null ? incomePaise : Math.min(incomePaise, s.upToPaise);
    if (top > prev) acc += BigInt(top - prev) * BigInt(s.rateBp);
    if (s.upToPaise == null || incomePaise <= s.upToPaise) break;
    prev = s.upToPaise;
  }
  return Number(divRound(acc, B10K, "half_up"));
}

export function annualTax({ config: c, grossIncomePaise, deductions, ageBand = "below_60", standardDeduction = true }: AnnualTaxInput): AnnualTaxResult {
  money("grossIncomePaise", grossIncomePaise);
  const slabs = c.slabs[ageBand];
  const standardDeductionPaise = standardDeduction ? Math.min(c.standardDeductionPaise, grossIncomePaise) : 0;
  const deductionsPaise = Math.min(allowedDeductions(c, deductions), grossIncomePaise - standardDeductionPaise);
  const taxableIncomePaise = roundPaise(grossIncomePaise - standardDeductionPaise - deductionsPaise, TEN_RUPEES);   // section 288A
  const slabTaxPaise = slabTax(slabs, taxableIncomePaise);

  // rebate (87A): full up to the limit; above it, with marginal relief, tax can't exceed the income over the limit
  let rebatePaise = 0;
  if (taxableIncomePaise <= c.rebate.maxIncomePaise) rebatePaise = Math.min(slabTaxPaise, c.rebate.maxRebatePaise);
  else if (c.rebate.marginalRelief) rebatePaise = Math.max(0, slabTaxPaise - (taxableIncomePaise - c.rebate.maxIncomePaise));
  const afterRebate = slabTaxPaise - rebatePaise;

  // surcharge with marginal relief: tax + surcharge may exceed the tax at the threshold by no more than the income over it
  let surchargePaise = 0;
  const bands = [...c.surcharge].sort((a, b) => a.overPaise - b.overPaise);
  const i = bands.findLastIndex((b) => taxableIncomePaise > b.overPaise);
  if (i >= 0) {
    const band = bands[i], prevRate = i > 0 ? bands[i - 1].rateBp : 0;
    surchargePaise = applyBp(afterRebate, band.rateBp);
    const atThreshold = slabTax(slabs, band.overPaise);
    const limit = atThreshold + applyBp(atThreshold, prevRate) + (taxableIncomePaise - band.overPaise);
    if (afterRebate + surchargePaise > limit) surchargePaise = Math.max(0, limit - afterRebate);
  }
  const cessPaise = applyBp(afterRebate + surchargePaise, c.cessBp);
  const totalTaxPaise = roundPaise(afterRebate + surchargePaise + cessPaise, TEN_RUPEES);   // section 288B
  return { fy: c.fy, regime: c.regime, grossIncomePaise, standardDeductionPaise, deductionsPaise, taxableIncomePaise, slabTaxPaise, rebatePaise, surchargePaise, cessPaise, totalTaxPaise };
}

/** Both regimes side by side for the same income and declarations (for the regime choice screen). */
export function compareRegimes(input: { oldConfig: IncomeTaxConfig; newConfig: IncomeTaxConfig; grossIncomePaise: number; deductions?: TaxDeductions; ageBand?: AgeBand }) {
  const old = annualTax({ config: input.oldConfig, grossIncomePaise: input.grossIncomePaise, deductions: input.deductions, ageBand: input.ageBand });
  const nu = annualTax({ config: input.newConfig, grossIncomePaise: input.grossIncomePaise, deductions: input.deductions, ageBand: input.ageBand });
  return { old, new: nu, better: nu.totalTaxPaise <= old.totalTaxPaise ? ("new" as const) : ("old" as const), savingPaise: Math.abs(nu.totalTaxPaise - old.totalTaxPaise) };
}

// ---------------------------------------------------------------- Monthly TDS
export type ProjectTdsInput = {
  fy: string;
  regime: "old" | "new";
  config: IncomeTaxConfig;
  /** Taxable income already paid this financial year (previous employer's included, if declared). */
  ytdTaxablePaise: number;
  /** Taxable income still expected this year, including this month. */
  projectedTaxablePaise: number;
  deductions?: TaxDeductions;
  /** TDS already deducted this financial year. */
  tdsDeductedPaise: number;
  /** Months left including this one (1–12); see remainingMonthsInFy. */
  remainingMonths: number;
  ageBand?: AgeBand;
};
export type ProjectTdsResult = { annual: AnnualTaxResult; annualIncomePaise: number; remainingTaxPaise: number; monthlyTdsPaise: number; excessDeductedPaise: number };

/** This month's TDS: (projected annual tax − TDS so far) spread evenly over the months left. */
export function projectTds(p: ProjectTdsInput): ProjectTdsResult {
  if (p.config.fy !== p.fy || p.config.regime !== p.regime) throw new RangeError(`rates are for FY ${p.config.fy} (${p.config.regime}), not FY ${p.fy} (${p.regime})`);
  if (!Number.isInteger(p.remainingMonths) || p.remainingMonths < 1 || p.remainingMonths > 12) throw new RangeError("remainingMonths must be 1–12");
  money("ytdTaxablePaise", p.ytdTaxablePaise); money("projectedTaxablePaise", p.projectedTaxablePaise); money("tdsDeductedPaise", p.tdsDeductedPaise);
  const annualIncomePaise = p.ytdTaxablePaise + p.projectedTaxablePaise;
  const annual = annualTax({ config: p.config, grossIncomePaise: annualIncomePaise, deductions: p.deductions, ageBand: p.ageBand });
  const remainingTaxPaise = Math.max(0, annual.totalTaxPaise - p.tdsDeductedPaise);
  const excessDeductedPaise = Math.max(0, p.tdsDeductedPaise - annual.totalTaxPaise);
  const monthlyTdsPaise = p.remainingMonths === 1 ? remainingTaxPaise : Math.min(remainingTaxPaise, Number(divRound(BigInt(remainingTaxPaise), BigInt(p.remainingMonths * RUPEE), "half_up")) * RUPEE);
  return { annual, annualIncomePaise, remainingTaxPaise, monthlyTdsPaise, excessDeductedPaise };
}
