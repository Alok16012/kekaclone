/**
 * Golden tests for the payroll engine: September 2026 for 17 people, every net pay worked out by hand below.
 *
 * Month: 1–30 Sep 2026 (30 calendar days). FY 2026-27, so 7 months are left including September (Sep…Mar).
 * Rates: erp's own statutory_rates data (UNVERIFIED general knowledge, see statutory/rates-data.ts):
 *   PF 12% + 12% on PF wages capped at ₹15,000, EPS 8.33% (max ₹1,250), each rounded to the rupee;
 *   ESI 0.75% + 3.25% when ESI wages ≤ ₹21,000, rounded UP to the rupee;
 *   PT Karnataka ₹200 from ₹25,000 gross; Maharashtra men ₹200 above ₹10,000, women ₹200 above ₹25,000;
 *   Tamil Nadu half-yearly, deducted in September on the half year's gross; no LWF is due in September.
 *   Income tax new regime: standard deduction ₹75,000, 0/5/10/15/20/25/30% in ₹4 lakh steps, full rebate to ₹12 lakh,
 *   4% cess, tax rounded to ₹10; monthly TDS = (annual tax − TDS so far) ÷ months left, to the rupee.
 *   Old regime: standard deduction ₹50,000, 0/5/20/30% (2.5L/5L/10L), 4% cess.
 *
 * Standard structure (the default one): BASIC 50% of monthly CTC, HRA = BASIC × 0.4, PF_EMPLOYER = min(BASIC, 15000) × 0.12,
 * SPECIAL balances to CTC. Every line but SPECIAL is rounded to a rupee. Monthly breakups used below:
 *   S24 (₹24,00,000): BASIC 1,00,000  HRA 40,000  PFER 1,800  SPECIAL 58,200      → earnings 1,98,200
 *   S12 (₹12,00,000): BASIC 50,000    HRA 20,000  PFER 1,800  SPECIAL 28,200      → earnings 98,200
 *   S10 (₹10,00,000): BASIC 41,667    HRA 16,667  PFER 1,800  SPECIAL 23,199.33   → earnings 81,533.33
 *   S7.2(₹7,20,000):  BASIC 30,000    HRA 12,000  PFER 1,800  SPECIAL 16,200      → earnings 58,200
 *   S6  (₹6,00,000):  BASIC 25,000    HRA 10,000  PFER 1,800  SPECIAL 13,200      → earnings 48,200
 *   S48 (₹48,00,000): BASIC 2,00,000  HRA 80,000  PFER 1,800  SPECIAL 1,18,200    → earnings 3,98,200
 *   S3.6(₹3,60,000):  BASIC 15,000    HRA 6,000   PFER 1,800  SPECIAL 7,200       → earnings 28,200
 *   S2.4(₹2,40,000):  BASIC 10,000    HRA 4,000   PFER 1,200  SPECIAL 4,800       → earnings 18,800
 */
import { describe, expect, it } from "vitest";
import { RATE_ROWS } from "@/server/modules/statutory/rates-data";
import type { EsiConfig, IncomeTaxConfig, LwfConfig, PfConfig, PtConfig } from "@/server/modules/statutory/config";
import { computeBreakup } from "@/server/modules/payroll/rules";
import { projectTds } from "@/server/modules/statutory/rules";
import {
  addMonths, ageBandFor, declaredDeductions, amountInWords, arrearsDue, attendanceWindows, bankFile, buildSegments, computeLine, countDays, csv, dayRate, ecrLine, epsMember, fnfNet,
  halfYear, indianWords, inr, monthEnd, noticeShortfall, periodDays, prorate, remainingMonths, valueDays, variancePct,
  type ComponentMeta, type ExtraItem, type LineInput,
} from "./rules";

const R = (rupees: number) => Math.round(rupees * 100);
const rate = <C,>(kind: string, state: string | null = null, regime: string | null = null, fy = "2026-27") =>
  RATE_ROWS.find((r) => r.kind === kind && r.stateCode === state && r.regime === regime && (kind !== "income_tax" || (r.config as IncomeTaxConfig).fy === fy))!.config as C;
const PF = rate<PfConfig>("pf"), ESI = rate<EsiConfig>("esi");
const NEW = rate<IncomeTaxConfig>("income_tax", null, "new"), OLD = rate<IncomeTaxConfig>("income_tax", null, "old");
const PT = (s: string) => rate<PtConfig>("pt", s);
const LWF = (s: string) => rate<LwfConfig>("lwf", s);

const C: Record<string, ComponentMeta> = {
  BASIC: { code: "BASIC", name: "Basic", kind: "earning", taxable: true, lopProrated: true, pfWage: true, esiWage: true, inArrears: true, onPayslip: true },
  HRA: { code: "HRA", name: "House rent allowance", kind: "earning", taxable: true, lopProrated: true, pfWage: false, esiWage: true, inArrears: true, onPayslip: true },
  SPECIAL: { code: "SPECIAL", name: "Special allowance", kind: "earning", taxable: true, lopProrated: true, pfWage: false, esiWage: true, inArrears: true, onPayslip: true },
  PF_EMPLOYER: { code: "PF_EMPLOYER", name: "PF (employer share)", kind: "employer_contribution", taxable: false, lopProrated: true, pfWage: false, esiWage: false, inArrears: true, onPayslip: true },
};
const S = (basic: number, hra: number, pfer: number, special: number) => ({ BASIC: R(basic), HRA: R(hra), PF_EMPLOYER: R(pfer), SPECIAL: R(special) });
const S24 = S(100000, 40000, 1800, 58200), S12 = S(50000, 20000, 1800, 28200), S10 = S(41667, 16667, 1800, 23199.33), S72 = S(30000, 12000, 1800, 16200);
const S6 = S(25000, 10000, 1800, 13200), S48 = S(200000, 80000, 1800, 118200), S36 = S(15000, 6000, 1800, 7200), S24k = S(10000, 4000, 1200, 4800);
const earn = (b: Record<string, number>) => b.BASIC + b.HRA + b.SPECIAL;

const M = "2026-09-01";
type Case = {
  name: string; breakup?: Record<string, number>; salaries?: { id: string; effectiveFrom: string; breakup: Record<string, number> }[];
  from?: string; to?: string; lop?: Record<string, number>; basis?: "calendar" | "working"; state?: string; gender?: "male" | "female";
  regime?: "old" | "new"; pf?: boolean; fullWage?: boolean; ytdTaxable?: number; ytdTds?: number; ytdPt?: number; halfGross?: number;
  extras?: ExtraItem[]; overrides?: LineInput["st"]["overrides"]; bank?: boolean; recurring?: number;
  taxDeductions?: LineInput["st"]["taxDeductions"]; taxExtra?: LineInput["st"]["taxExtra"];
};
const WORKING = new Set(Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`).filter((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())));

function run(c: Case) {
  const basis = c.basis ?? "calendar";
  const salaries = c.salaries ?? [{ id: "s1", effectiveFrom: "2025-01-01", breakup: c.breakup! }];
  const from = c.from ?? M, to = c.to ?? monthEnd(M);
  const segments = buildSegments({ month: M, basis, workingDates: WORKING, employedFrom: from, employedTo: to, salaries, lopByDate: c.lop ?? {}, undatedLop: 0 });
  const last = salaries[salaries.length - 1].breakup;
  const state = c.state ?? "KA";
  return computeLine({
    month: M, periodDays: periodDays(M, basis, WORKING), segments, components: C, lopDays: Object.values(c.lop ?? {}).reduce((a, b) => a + b, 0), extras: c.extras ?? [],
    hasBank: c.bank ?? true,
    st: {
      pfEnabled: c.pf ?? true, pfOnFullWage: c.fullWage ?? false, epsMember: true, esiEnabled: true, pf: PF, esi: ESI, pt: PT(state), lwf: LWF(state),
      tax: c.regime === "old" ? OLD : NEW, regime: c.regime ?? "new", ageBand: "below_60", gender: c.gender ?? "male", ptState: state, hasPan: true, hasUan: true,
      esiCoverageGrossPaise: earn(last), ytdPtPaise: c.ytdPt ?? 0, ytdTaxablePaise: c.ytdTaxable ?? 0, ytdTdsPaise: c.ytdTds ?? 0,
      ptHalfGrossPaise: c.halfGross ?? 0, ptMonthsLeftInHalf: 1, recurringTaxablePaise: c.recurring ?? earn(last),
      remainingMonths: remainingMonths(M, c.to ?? null), overrides: c.overrides ?? {}, taxDeductions: c.taxDeductions ?? null, taxExtra: c.taxExtra ?? null,
    },
  });
}
const ded = (r: ReturnType<typeof run>, code: string) => r.deductions.filter((d) => d.code === code).reduce((t, d) => t + d.paise, 0);
const emp = (r: ReturnType<typeof run>, code: string) => r.employer.find((d) => d.code === code)?.paise ?? 0;
const x = (code: string, label: string, rupees: number, side: "earning" | "deduction", o: Partial<ExtraItem> = {}): ExtraItem =>
  ({ code, label, paise: R(rupees), kind: "input", side, taxable: side === "earning", pfWage: false, esiWage: false, ...o });

describe("standard structure breakups used by the golden cases", () => {
  const def = { lines: [
    { code: "BASIC", name: "Basic", kind: "earning" as const, calc: "pct_ctc" as const, value: "50" },
    { code: "HRA", name: "HRA", kind: "earning" as const, calc: "formula" as const, formula: "[BASIC] * 0.4" },
    { code: "PF_EMPLOYER", name: "PF", kind: "employer_contribution" as const, calc: "formula" as const, formula: "min([BASIC], 15000) * 0.12" },
    { code: "SPECIAL", name: "Special", kind: "earning" as const, calc: "balancing" as const },
  ] };
  it.each([[24_00_000, S24], [12_00_000, S12], [10_00_000, S10], [7_20_000, S72], [6_00_000, S6], [48_00_000, S48], [3_60_000, S36], [2_40_000, S24k]])("₹%i", (ctc, expected) => {
    const b = computeBreakup(def, R(ctc));
    expect(b.ok && b.breakup).toEqual(expected);
  });
});

describe("golden net pay, September 2026", () => {
  it("G1 full month, ₹12L, Karnataka: 98,200 − PF 1,800 − PT 200 = 96,200; tax within the ₹12L rebate", () => {
    // annual income 4,91,000 (Apr–Aug) + 98,200 × 7 = 11,78,400; − 75,000 = 11,03,400 ≤ 12L → tax 0
    const r = run({ name: "G1", breakup: S12, ytdTaxable: R(491000), ytdPt: R(1000) });
    expect(r.grossPaise).toBe(R(98200));
    expect(ded(r, "PF_EMPLOYEE")).toBe(R(1800)); expect(ded(r, "PT")).toBe(R(200)); expect(ded(r, "TDS")).toBe(0); expect(ded(r, "ESI")).toBe(0);
    // employer PF 1,800 = EPS 15,000 × 8.33% = 1,249.50 → 1,250 + EPF 550
    expect(emp(r, "PF_EMPLOYER")).toBe(R(1800)); expect(r.statutory.pf?.epsPaise).toBe(R(1250)); expect(r.statutory.pf?.epfPaise).toBe(R(550));
    expect(r.netPaise).toBe(R(96200));
  });
  it("G2 ₹24L with TDS: 1,98,200 − 1,800 − 200 − TDS 23,911 = 1,72,289", () => {
    // annual 9,91,000 + 1,98,200 × 7 = 23,78,400; taxable 23,03,400.
    // slabs 20,000 + 40,000 + 60,000 + 80,000 + 25% × 3,03,400 (75,850) = 2,75,850; cess 11,034 → 2,86,884 → 2,86,880.
    // less TDS so far 1,19,500 = 1,67,380 ÷ 7 = 23,911.43 → 23,911
    const r = run({ name: "G2", breakup: S24, ytdTaxable: R(991000), ytdTds: R(119500), ytdPt: R(1000) });
    expect(r.statutory.tds?.annualTaxPaise).toBe(R(286880));
    expect(ded(r, "TDS")).toBe(R(23911));
    expect(r.netPaise).toBe(R(172289));
  });
  it("G3 ₹2.4L, ESI covered: 18,800 − PF 1,200 − ESI 141 = 17,459; no PT below ₹25,000", () => {
    // ESI 18,800 × 0.75% = 141.00; employer 18,800 × 3.25% = 611.00. EPS 10,000 × 8.33% = 833, EPF 367
    const r = run({ name: "G3", breakup: S24k, ytdTaxable: R(94000) });
    expect(ded(r, "ESI")).toBe(R(141)); expect(emp(r, "ESI_EMPLOYER")).toBe(R(611));
    expect(r.statutory.pf?.epsPaise).toBe(R(833)); expect(r.statutory.pf?.epfPaise).toBe(R(367));
    expect(ded(r, "PT")).toBe(0);
    expect(r.netPaise).toBe(R(17459));
  });
  it("G4 two days LOP on ₹6L: 28/30 of each line, to the rupee → 44,986 − 1,800 − 200 = 42,986", () => {
    // BASIC 25,000 × 28/30 = 23,333.33 → 23,333; HRA 9,333.33 → 9,333; SPECIAL 12,320 → gross 44,986
    const r = run({ name: "G4", breakup: S6, lop: { "2026-09-08": 1, "2026-09-09": 1 }, ytdTaxable: R(241000) });
    expect(r.payableDays).toBe(28);
    expect(r.earnings.map((e) => e.paise)).toEqual([R(23333), R(9333), R(12320)]);
    expect(r.netPaise).toBe(R(42986));
  });
  it("G5 ₹48L, old regime, no PF: 3,98,200 − PT 200 − TDS 1,11,466 = 2,86,534", () => {
    // annual 19,91,000 + 3,98,200 × 7 = 47,78,400; − 50,000 = 47,28,400.
    // 12,500 + 1,00,000 + 30% × 37,28,400 (11,18,520) = 12,31,020; cess 49,240.80 → 12,80,260.80 → 12,80,260.
    // less 5,00,000 deducted = 7,80,260 ÷ 7 = 1,11,465.71 → 1,11,466
    const r = run({ name: "G5", breakup: S48, regime: "old", pf: false, ytdTaxable: R(1991000), ytdTds: R(500000), ytdPt: R(1000) });
    expect(ded(r, "PF_EMPLOYEE")).toBe(0); expect(emp(r, "PF_EMPLOYER")).toBe(0);
    expect(ded(r, "TDS")).toBe(R(111466));
    expect(r.netPaise).toBe(R(286534));
  });
  it("G6 joined 16 Sep on ₹12L: 15/30 → 49,100 − 1,800 − 200 = 47,100; warns when no bank account", () => {
    // BASIC 25,000; HRA 10,000; SPECIAL 14,100. TDS: 49,100 + 98,200 × 6 = 6,38,300 → rebate → 0
    const r = run({ name: "G6", breakup: S12, from: "2026-09-16", bank: false });
    expect(r.employedDays).toBe(15);
    expect(r.grossPaise).toBe(R(49100));
    expect(r.netPaise).toBe(R(47100));
    expect(r.warnings.some((w) => /bank account/.test(w))).toBe(true);
  });
  it("G7 left 10 Sep on ₹10L: 10/30 → 27,178 − PF 1,667 − PT 200 = 25,311; TDS settles in one month", () => {
    // BASIC 41,667 × 10/30 = 13,889; HRA 16,667 × 10/30 = 5,555.67 → 5,556; SPECIAL 23,199.33 × 10/30 = 7,733.11 → 7,733
    // PF 13,889 × 12% = 1,666.68 → 1,667; EPS 1,156.95 → 1,157
    const r = run({ name: "G7", breakup: S10, to: "2026-09-10", ytdTaxable: 40766665 });
    expect(r.grossPaise).toBe(R(27178));
    expect(ded(r, "PF_EMPLOYEE")).toBe(R(1667)); expect(r.statutory.pf?.epsPaise).toBe(R(1157));
    expect(r.statutory.tds?.remainingMonths).toBe(1);
    expect(r.netPaise).toBe(R(25311));
  });
  it("G8 revised from ₹6L to ₹7.2L on 16 Sep: 15 days on each → 53,200 − 1,800 − 200 = 51,200", () => {
    // BASIC (25,000 + 30,000) × 15/30 = 27,500; HRA 11,000; SPECIAL (13,200 + 16,200) / 2 = 14,700
    const r = run({ name: "G8", salaries: [{ id: "a", effectiveFrom: "2025-04-01", breakup: S6 }, { id: "b", effectiveFrom: "2026-09-16", breakup: S72 }], ytdTaxable: R(241000) });
    expect(r.earnings.map((e) => e.paise)).toEqual([R(27500), R(11000), R(14700)]);
    expect(r.netPaise).toBe(R(51200));
  });
  it("G9 Tamil Nadu half-yearly PT in September: half-year gross 1,69,200 → ₹1,250; 28,200 − 1,800 − 1,250 = 25,150", () => {
    const r = run({ name: "G9", breakup: S36, state: "TN", halfGross: R(141000), ytdTaxable: R(141000) });
    expect(ded(r, "PT")).toBe(R(1250));
    expect(r.netPaise).toBe(R(25150));
  });
  it("G10 Maharashtra, woman earning 18,800: no PT; 18,800 − 1,200 − 141 = 17,459", () => {
    expect(run({ name: "G10", breakup: S24k, state: "MH", gender: "female" }).netPaise).toBe(R(17459));
  });
  it("G11 Maharashtra, man earning 18,800: PT ₹200 → 17,259", () => {
    const r = run({ name: "G11", breakup: S24k, state: "MH", gender: "male" });
    expect(ded(r, "PT")).toBe(R(200));
    expect(r.netPaise).toBe(R(17259));
  });
  it("G12 bonus ₹20,000 and a ₹1,500 deduction: 1,18,200 − 1,800 − 200 − 1,500 = 1,14,700", () => {
    // annual 4,91,000 + 1,18,200 + 98,200 × 6 = 11,98,400 → taxable 11,23,400 → rebate → 0
    const r = run({ name: "G12", breakup: S12, ytdTaxable: R(491000), extras: [x("BONUS", "Bonus", 20000, "earning"), x("ADHOC_DED", "Canteen", 1500, "deduction")] });
    expect(r.grossPaise).toBe(R(118200)); expect(ded(r, "TDS")).toBe(0);
    expect(r.netPaise).toBe(R(114700));
  });
  it("G13 expense reimbursement ₹4,250.50 (not taxed) and loan EMI ₹5,000: 32,450.50 − 1,800 − 200 − 5,000 = 25,450.50", () => {
    const r = run({ name: "G13", breakup: S36, ytdTaxable: R(141000), extras: [x("EXPENSE", "Expense claim #12", 4250.5, "earning", { taxable: false, kind: "reimbursement" }), x("LOAN_EMI", "Loan EMI", 5000, "deduction")] });
    expect(r.statutory.taxablePaise).toBe(R(28200));
    expect(r.netPaise).toBe(R(25450.5));
  });
  it("G14 arrears for August (8,000, Basic part counts for PF but PF stays capped): 1,06,200 − 2,000 = 1,04,200", () => {
    const arr = [x("ARR_BASIC", "Arrears: Basic", 5000, "earning", { pfWage: true, esiWage: true, kind: "arrear" }), x("ARR_HRA", "Arrears: HRA", 2000, "earning", { esiWage: true, kind: "arrear" }), x("ARR_SPECIAL", "Arrears: Special", 1000, "earning", { esiWage: true, kind: "arrear" })];
    const r = run({ name: "G14", breakup: S12, ytdTaxable: R(491000), extras: arr });
    expect(r.statutory.pf?.wagePaise).toBe(R(15000));
    expect(r.netPaise).toBe(R(104200));
  });
  it("G15 PF on full wages and PT overridden to nil: PF 12% × 50,000 = 6,000; 98,200 − 6,000 = 92,200", () => {
    const r = run({ name: "G15", breakup: S12, fullWage: true, overrides: { PT: 0 }, ytdTaxable: R(491000) });
    expect(ded(r, "PF_EMPLOYEE")).toBe(R(6000)); expect(emp(r, "PF_EMPLOYER")).toBe(R(6000));
    expect(r.statutory.pf?.epsPaise).toBe(R(1250)); expect(r.statutory.pf?.epfPaise).toBe(R(4750));
    expect(ded(r, "PT")).toBe(0);
    expect(r.netPaise).toBe(R(92200));
  });
  it("G16 a ₹25,000 recovery on ₹18,800: 18,800 − 1,200 − 141 − 25,000 = −7,541, flagged", () => {
    const r = run({ name: "G16", breakup: S24k, extras: [x("ADHOC_DED", "Salary advance recovery", 25000, "deduction")] });
    expect(r.netPaise).toBe(-R(7541));
    expect(r.warnings.some((w) => /negative/.test(w))).toBe(true);
  });
  it("G17 working-day basis (22 days in Sep 2026), 1½ days LOP: 20.5/22 → 26,277 − 1,677 − 200 = 24,400", () => {
    // BASIC 15,000 × 20.5/22 = 13,977.27 → 13,977; HRA 5,590.91 → 5,591; SPECIAL 6,709.09 → 6,709; PF 1,677.24 → 1,677
    const r = run({ name: "G17", breakup: S36, basis: "working", lop: { "2026-09-14": 0.5, "2026-09-15": 1 }, ytdTaxable: R(141000) });
    expect(r.payableDays).toBe(20.5);
    expect(r.grossPaise).toBe(R(26277));
    expect(r.netPaise).toBe(R(24400));
  });
  it("is deterministic and keeps integer paise everywhere", () => {
    const c: Case = { name: "again", breakup: S10, to: "2026-09-10", ytdTaxable: 40766665 };
    expect(run(c)).toEqual(run(c));
    const r = run({ name: "ints", breakup: S10, lop: { "2026-09-03": 0.5 } });
    for (const i of [...r.earnings, ...r.deductions, ...r.employer]) expect(Number.isInteger(i.paise)).toBe(true);
    expect(r.netPaise).toBe(r.grossPaise - r.totalDeductionsPaise);
  });
});

describe("days and windows", () => {
  it("cut-off on the 25th: 1–25 counts now, 26–31 of last month rolls in", () => {
    expect(attendanceWindows("2026-09-01", 25)).toEqual({ current: { from: "2026-09-01", to: "2026-09-25" }, rolled: { month: "2026-08-01", from: "2026-08-26", to: "2026-08-31" }, lateFrom: "2026-09-26" });
    expect(attendanceWindows("2026-04-01", 30)).toEqual({ current: { from: "2026-04-01", to: "2026-04-30" }, rolled: { month: "2026-03-01", from: "2026-03-31", to: "2026-03-31" }, lateFrom: null });
    expect(attendanceWindows("2026-03-01", 28).rolled).toBeNull();   // February 2026 has 28 days
  });
  it("period days by basis", () => {
    expect(periodDays("2026-02-01", "calendar")).toBe(28);
    expect(periodDays("2026-02-01", "fixed_30")).toBe(30);
    expect(periodDays("2026-09-01", "working", WORKING)).toBe(22);
    expect(countDays("2026-02-01", "2026-02-01", "2026-02-28", "fixed_30")).toBe(30);
    expect(countDays("2026-02-01", "2026-02-15", "2026-02-28", "fixed_30")).toBe(14);
  });
  it("fixed_30: a whole February is 30 days even across a revision", () => {
    const segs = buildSegments({ month: "2026-02-01", basis: "fixed_30", employedFrom: "2026-02-01", employedTo: "2026-02-28", lopByDate: {}, undatedLop: 1,
      salaries: [{ id: "a", effectiveFrom: "2025-01-01", breakup: { BASIC: 3000000 } }, { id: "b", effectiveFrom: "2026-02-15", breakup: { BASIC: 6000000 } }] });
    expect(segs.map((s) => [s.employedDays, s.payableDays])).toEqual([[14, 14], [16, 15]]);
    // (30,000 × 14 + 60,000 × 15) ÷ 30 = 44,000
    expect(prorate("BASIC", segs, 30, true)).toBe(R(44000));
    expect(prorate("BASIC", segs, 30, false)).toBe(R(46000));
  });
  it("values days at a month's rate (LOP adjustments), only LOP-prorated earnings", () => {
    expect(valueDays(S12, C, 1.5, 30)).toEqual({ BASIC: R(2500), HRA: R(1000), SPECIAL: R(1410) });
    expect(valueDays(S10, C, 1, 31)).toEqual({ BASIC: R(1344), HRA: R(538), SPECIAL: R(748) });   // 1,344.10 / 537.65 / 748.37
  });
  it("months left in the year, cut short by an exit; half years; age bands", () => {
    expect(remainingMonths("2026-04-01", null)).toBe(12);
    expect(remainingMonths("2027-03-01", null)).toBe(1);
    expect(remainingMonths("2026-09-01", "2026-11-15")).toBe(3);
    expect(halfYear("2026-09-01")).toEqual({ start: "2026-04-01", monthsLeft: 1 });
    expect(halfYear("2027-01-01")).toEqual({ start: "2026-10-01", monthsLeft: 3 });
    expect(ageBandFor("1966-03-31", "2026-09-01")).toBe("senior");
    expect(ageBandFor("1967-04-01", "2026-09-01")).toBe("below_60");
    expect(ageBandFor("1946-01-01", "2026-09-01")).toBe("super_senior");
    expect(epsMember("1968-10-15", "2026-09-01")).toBe(true);
    expect(epsMember("1968-09-15", "2026-09-01")).toBe(false);
    expect(addMonths("2026-01-01", -2)).toBe("2025-11-01");
  });
});

describe("arrears", () => {
  it("expected minus everything already paid, per month and component, only 'in arrears' lines", () => {
    const out = arrearsDue([
      { month: "2026-07-01", expected: { BASIC: R(30000), HRA: R(12000), PF_EMPLOYER: R(1800) }, paid: { BASIC: R(25000), HRA: R(10000) } },
      { month: "2026-08-01", expected: { BASIC: R(30000) }, paid: { BASIC: R(30000) } },
    ], { ...C, HRA: { ...C.HRA, inArrears: false } });
    expect(out.map((o) => [o.code, o.paise, o.sourceMonth])).toEqual([["ARR_BASIC", R(5000), "2026-07-01"]]);
    expect(out[0].pfWage).toBe(true);
  });
});

describe("words, money and files", () => {
  it("Indian numbering in words", () => {
    expect(indianWords(0)).toBe("Zero");
    expect(indianWords(105)).toBe("One Hundred Five");
    expect(indianWords(1_23_45_678)).toBe("One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight");
    expect(amountInWords(R(172289))).toBe("Rupees One Lakh Seventy Two Thousand Two Hundred Eighty Nine Only");
    expect(amountInWords(R(25450.5))).toBe("Rupees Twenty Five Thousand Four Hundred Fifty and Fifty Paise Only");
    expect(amountInWords(-R(7541))).toBe("Minus Rupees Seven Thousand Five Hundred Forty One Only");
    expect(inr(R(1234567.8))).toBe("Rs. 12,34,567.80");
    expect(inr(R(999))).toBe("Rs. 999.00");
  });
  it("variance", () => {
    expect(variancePct(110, 100)).toBe(10);
    expect(variancePct(5, 0)).toBeNull();
    expect(variancePct(90, 100)).toBe(-10);
  });
  it("bank files and ECR lines", () => {
    const rows = [{ employeeNumber: "E-001", name: "Rohan", holderName: "Rohan Mehta", accountNumber: "50100000000", ifsc: "HDFC0001234", bankName: "HDFC Bank", netPaise: R(172289) }];
    expect(bankFile("neft_csv", rows, { month: M, valueDate: "2026-09-30" })).toBe("Beneficiary name,Account number,IFSC,Bank,Amount,Narration,Employee number\r\nRohan Mehta,50100000000,HDFC0001234,HDFC Bank,172289.00,Salary Sep 26,E-001\r\n");
    const pipe = bankFile("hdfc_bulk", rows, { month: M, valueDate: "2026-09-30", payerIfscPrefix: "HDFC" });
    expect(pipe.startsWith("I|E-001|50100000000|172289.00|Rohan Mehta|")).toBe(true);
    expect(pipe).toContain("|30/09/2026|");
    expect(ecrLine({ uan: "100200300400", name: "Rohan Mehta", grossPaise: R(198200), epfWagePaise: R(15000), epsWagePaise: R(15000), edliWagePaise: R(15000), employeePaise: R(1800), epsPaise: R(1250), epfPaise: R(550), ncpDays: 0 }))
      .toBe("100200300400#~#ROHAN MEHTA#~#198200#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0");
    expect(csv([["=cmd", "-5", "a,b"]])).toBe("'=cmd,-5,\"a,b\"\r\n");
  });
});

describe("full and final", () => {
  it("net counts only items to pay", () => {
    expect(fnfNet([
      { key: "salary", label: "Salary", side: "earning", paise: R(27178), action: "pay", auto: true },
      { key: "gratuity", label: "Gratuity", side: "earning", paise: R(100000), action: "paid_outside", auto: true },
      { key: "notice", label: "Notice", side: "deduction", paise: R(5000), action: "pay", auto: true },
      { key: "asset", label: "Asset", side: "deduction", paise: R(2000), action: "void", auto: true },
    ])).toBe(R(22178));
  });
  it("notice shortfall and a day's pay", () => {
    expect(noticeShortfall({ resignationDate: "2026-08-01", lastWorkingDate: "2026-08-31", noticeDays: 60, waivedDays: 10 })).toBe(20);
    expect(noticeShortfall({ resignationDate: "2026-08-01", lastWorkingDate: "2026-10-15", noticeDays: 60, waivedDays: 0 })).toBe(0);
    expect(dayRate(R(98200), 20)).toBe(R(65467));   // 98,200 ÷ 30 × 20 = 65,466.67
  });
});

describe("TDS with a submitted tax declaration", () => {
  const extra = { previousIncomePaise: R(300000), previousTdsPaise: R(20000), previousPfPaise: R(5000), previousPtPaise: R(800), otherIncomePaise: R(10000), ytdEmployeePfPaise: R(9000) };
  it("adds actual PF to 80C and PT to section 16(iii) for the whole year", () => {
    const d = declaredDeductions({ section80CPaise: R(50000), hraExemptPaise: R(120000) }, extra, { pfPaise: R(1800), ptPaise: R(200), ytdPtPaise: R(1000), monthsLeft: 7 });
    // 80C: 50,000 declared + 5,000 previous employer + 9,000 paid here + 1,800 × 7 = 76,600; PT: 800 + 1,000 + 200 × 7 = 3,200 (capped later)
    expect(d.section80CPaise).toBe(R(76600)); expect(d.professionalTaxPaise).toBe(R(3200)); expect(d.hraExemptPaise).toBe(R(120000));
  });
  it("old regime ₹24L: previous employer income and TDS, other income and declarations change this month's TDS", () => {
    const td = { section80CPaise: R(150000), hraExemptPaise: R(240000), otherChapterVIAPaise: R(25000), homeLoanInterestPaise: R(0) };
    const r = run({ name: "D1", breakup: S24, regime: "old", ytdTaxable: R(991000), ytdTds: R(119500), ytdPt: R(1000), taxDeductions: td, taxExtra: extra });
    const plain = run({ name: "D0", breakup: S24, regime: "old", ytdTaxable: R(991000), ytdTds: R(119500), ytdPt: R(1000) });
    const want = projectTds({ fy: "2026-27", regime: "old", config: OLD, ytdTaxablePaise: R(991000 + 300000 + 10000), projectedTaxablePaise: R(198200) * 7,
      deductions: declaredDeductions(td, extra, { pfPaise: R(1800), ptPaise: R(200), ytdPtPaise: R(1000), monthsLeft: 7 }), tdsDeductedPaise: R(119500 + 20000), remainingMonths: 7, ageBand: "below_60" });
    expect(ded(r, "TDS")).toBe(want.monthlyTdsPaise);
    expect(r.statutory.tds?.standardDeductionOnly).toBe(false);
    expect(plain.statutory.tds?.standardDeductionOnly).toBe(true);
    expect(r.statutory.tds?.annualIncomePaise).toBe(R(991000 + 300000 + 10000) + R(198200) * 7);
    expect(ded(r, "TDS")).not.toBe(ded(plain, "TDS"));
  });
  it("without a declaration the extra inputs are ignored", () => {
    const a = run({ name: "D2", breakup: S24, ytdTaxable: R(991000), ytdTds: R(119500), ytdPt: R(1000), taxExtra: extra });
    const b = run({ name: "D3", breakup: S24, ytdTaxable: R(991000), ytdTds: R(119500), ytdPt: R(1000) });
    expect(ded(a, "TDS")).toBe(ded(b, "TDS"));
  });
});
