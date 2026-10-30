/**
 * Golden tests for the statutory engine. Expected values were worked out by hand from the (unverified) rate tables
 * in rates-data.ts. When a CA corrects a rate, change the data and the expectations together.
 */
import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMAS, STATES, type IncomeTaxConfig, type LwfConfig, type PtConfig, type RateKind, type StateCode } from "./config";
import { ASSUMED_SAME, RATE_ROWS, UNVERIFIED } from "./rates-data";
import {
  annualTax, applyBp, compareRegimes, esi, esiCoverageMonth, esiPeriod, fyOf, fyRange, gratuity, lwf, pf, professionalTax,
  projectTds, remainingMonthsInFy, roundPaise, serviceLength, slabTax,
} from "./rules";

const r = (rupees: number) => Math.round(rupees * 100);
const L = 100_000;
const row = (kind: RateKind, state: string | null = null, regime: string | null = null, fy?: string) =>
  RATE_ROWS.find((x) => x.kind === kind && x.stateCode === state && x.regime === regime && (!fy || (x.config as IncomeTaxConfig).fy === fy))!.config;
const PF = row("pf") as Parameters<typeof pf>[0]["config"];
const ESI = row("esi") as Parameters<typeof esi>[0]["config"];
const GR = row("gratuity") as Parameters<typeof gratuity>[0]["config"];
const PT = (s: StateCode) => row("pt", s) as PtConfig;
const LWF = (s: StateCode) => row("lwf", s) as LwfConfig;
const NEW = row("income_tax", null, "new", "2025-26") as IncomeTaxConfig;
const OLD = row("income_tax", null, "old", "2025-26") as IncomeTaxConfig;
const NEW27 = row("income_tax", null, "new", "2026-27") as IncomeTaxConfig;
const OLD27 = row("income_tax", null, "old", "2026-27") as IncomeTaxConfig;

describe("rate data", () => {
  it("every row matches its schema, is marked unverified and has a sane date range", () => {
    for (const x of RATE_ROWS) {
      expect(() => CONFIG_SCHEMAS[x.kind].parse(x.config)).not.toThrow();
      expect(x.sourceNote).toContain(UNVERIFIED);
      if (x.effectiveTo) expect(x.effectiveTo > x.effectiveFrom).toBe(true);
    }
  });
  it("PT and LWF cover every listed state; FY 2026-27 is flagged as assumed", () => {
    for (const s of Object.keys(STATES)) { expect(RATE_ROWS.some((x) => x.kind === "pt" && x.stateCode === s)).toBe(true); expect(RATE_ROWS.some((x) => x.kind === "lwf" && x.stateCode === s)).toBe(true); }
    expect(RATE_ROWS.filter((x) => x.kind === "income_tax")).toHaveLength(4);
    for (const x of RATE_ROWS.filter((x) => x.kind === "income_tax" && (x.config as IncomeTaxConfig).fy === "2026-27")) expect(x.sourceNote).toContain(ASSUMED_SAME);
  });
  it("slab upper bounds go up and only the last is open-ended", () => {
    const check = (s: { upToPaise: number | null }[]) => s.forEach((x, i) => { if (i < s.length - 1) { expect(x.upToPaise).not.toBeNull(); expect(s[i + 1].upToPaise == null || s[i + 1].upToPaise! > x.upToPaise!).toBe(true); } else expect(x.upToPaise).toBeNull(); });
    for (const x of RATE_ROWS) {
      if (x.kind === "pt") { const c = x.config as PtConfig; check(c.slabs); if (c.femaleSlabs) check(c.femaleSlabs); }
      if (x.kind === "lwf") check((x.config as LwfConfig).slabs);
      if (x.kind === "income_tax") Object.values((x.config as IncomeTaxConfig).slabs).forEach(check);
    }
  });
  it("no overlapping versions of the same kind/state/regime", () => {
    const groups = new Map<string, typeof RATE_ROWS>();
    for (const x of RATE_ROWS) { const k = `${x.kind}|${x.stateCode}|${x.regime}`; groups.set(k, [...(groups.get(k) ?? []), x]); }
    for (const g of groups.values()) {
      const s = [...g].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      for (let i = 1; i < s.length; i++) expect(s[i - 1].effectiveTo != null && s[i - 1].effectiveTo! < s[i].effectiveFrom).toBe(true);
    }
  });
});

describe("integer helpers", () => {
  it("applies basis points exactly and rounds once", () => {
    expect(applyBp(r(15_000), 833, 100)).toBe(r(1_250));   // 1249.50 → 1250 (half up)
    expect(applyBp(r(15_000), 75, 100, "up")).toBe(r(113)); // 112.50 → 113
    expect(applyBp(r(100), 75, 100, "down")).toBe(0);
    expect(roundPaise(r(12_345.4), 1_000)).toBe(r(12_350));
    expect(roundPaise(r(12_344.99), 1_000)).toBe(r(12_340));
  });
  it("refuses fractional or negative money", () => {
    expect(() => pf({ config: PF, pfWagePaise: 10.5 })).toThrow(RangeError);
    expect(() => esi({ config: ESI, grossPaise: -1 })).toThrow(RangeError);
    expect(() => annualTax({ config: NEW, grossIncomePaise: Number.MAX_SAFE_INTEGER + 2 })).toThrow(RangeError);
  });
});

describe("PF", () => {
  it("below the ceiling: 12% + 12%, EPS 8.33%, admin and EDLI 0.5%", () => {
    expect(pf({ config: PF, pfWagePaise: r(10_000) })).toEqual({
      wagePaise: r(10_000), epsWagePaise: r(10_000), edliWagePaise: r(10_000), employeePaise: r(1_200), employerPaise: r(1_200),
      employerEpsPaise: r(833), employerEpfPaise: r(367), adminChargePaise: r(50), edliPaise: r(50),
    });
  });
  it("at the ₹15,000 ceiling EPS rounds to ₹1,250", () => {
    const x = pf({ config: PF, pfWagePaise: r(15_000) });
    expect([x.employeePaise, x.employerPaise, x.employerEpsPaise, x.employerEpfPaise, x.adminChargePaise, x.edliPaise]).toEqual([r(1_800), r(1_800), r(1_250), r(550), r(75), r(75)]);
  });
  it("above the ceiling, capped by default", () => {
    const x = pf({ config: PF, pfWagePaise: r(25_000) });
    expect([x.wagePaise, x.employeePaise, x.employerEpsPaise, x.employerEpfPaise]).toEqual([r(15_000), r(1_800), r(1_250), r(550)]);
  });
  it("full-wage option: 12% of the whole wage, EPS still ₹1,250, EDLI still capped", () => {
    const x = pf({ config: PF, pfWagePaise: r(25_000), fullWage: true });
    expect([x.employeePaise, x.employerPaise, x.employerEpsPaise, x.employerEpfPaise, x.adminChargePaise, x.edliPaise]).toEqual([r(3_000), r(3_000), r(1_250), r(1_750), r(125), r(75)]);
  });
  it("odd wage rounds each contribution to the nearest rupee", () => {
    const x = pf({ config: PF, pfWagePaise: 1_234_567 });   // ₹12,345.67
    expect([x.employeePaise, x.employerEpsPaise, x.employerEpfPaise, x.adminChargePaise, x.edliPaise]).toEqual([r(1_481), r(1_028), r(453), r(62), r(62)]);
  });
  it("mid-month joiner on prorated wages (₹15,000 × 10/30)", () => {
    const x = pf({ config: PF, pfWagePaise: r(5_000) });
    expect([x.employeePaise, x.employerEpsPaise, x.employerEpfPaise]).toEqual([r(600), r(417), r(183)]);   // 416.50 → 417
  });
  it("not in the pension scheme: the whole employer share goes to EPF", () => {
    const x = pf({ config: PF, pfWagePaise: r(20_000), epsMember: false });
    expect([x.employerPaise, x.employerEpsPaise, x.employerEpfPaise]).toEqual([r(1_800), 0, r(1_800)]);
  });
  it("no wages, no PF", () => {
    expect(Object.values(pf({ config: PF, pfWagePaise: 0 })).every((v) => v === 0)).toBe(true);
  });
});

describe("ESI", () => {
  it("covered at exactly ₹21,000; contributions rounded up", () => {
    expect(esi({ config: ESI, grossPaise: r(21_000) })).toMatchObject({ covered: true, employeePaise: r(158), employerPaise: r(683) });
  });
  it("one paisa over the ceiling is not covered", () => {
    expect(esi({ config: ESI, grossPaise: r(21_000) + 1 })).toMatchObject({ covered: false, employeePaise: 0, employerPaise: 0 });
  });
  it("₹15,000 gross", () => {
    expect(esi({ config: ESI, grossPaise: r(15_000) })).toMatchObject({ employeePaise: r(113), employerPaise: r(488) });
  });
  it("period lock: covered in April stays covered after a July raise, on actual wages", () => {
    expect(esi({ config: ESI, grossPaise: r(25_000), coverageGrossPaise: r(20_000) })).toMatchObject({ covered: true, employeePaise: r(188), employerPaise: r(813) });
  });
  it("period lock: not covered at the period start stays out even if wages drop", () => {
    expect(esi({ config: ESI, grossPaise: r(19_000), coverageGrossPaise: r(22_000) })).toMatchObject({ covered: false, employeePaise: 0 });
  });
  it("persons with disability: ₹25,000 ceiling", () => {
    expect(esi({ config: ESI, grossPaise: r(24_000), disabled: true })).toMatchObject({ covered: true, employeePaise: r(180), employerPaise: r(780) });
    expect(esi({ config: ESI, grossPaise: r(24_000) }).covered).toBe(false);
  });
  it("low daily wage: employer pays, employee doesn't", () => {
    expect(esi({ config: ESI, grossPaise: r(5_100), averageDailyWagePaise: r(170) })).toMatchObject({ employeeExempt: true, employeePaise: 0, employerPaise: r(166) });
  });
  it("contribution periods Apr–Sep and Oct–Mar", () => {
    expect(esiPeriod("2025-07-15", ESI)).toEqual({ start: "2025-04-01", end: "2025-09-30" });
    expect(esiPeriod("2026-02-10", ESI)).toEqual({ start: "2025-10-01", end: "2026-03-31" });
    expect(esiPeriod("2025-10-01", ESI)).toEqual({ start: "2025-10-01", end: "2026-03-31" });
    expect(esiPeriod("2025-09-30", ESI)).toEqual({ start: "2025-04-01", end: "2025-09-30" });
  });
  it("mid-period joiner: coverage is decided by the joining month", () => {
    expect(esiCoverageMonth("2025-08-01", "2025-06-20", ESI)).toBe("2025-06-01");
    expect(esiCoverageMonth("2025-08-01", "2024-01-10", ESI)).toBe("2025-04-01");
    expect(esiCoverageMonth("2026-01-01", null, ESI)).toBe("2025-10-01");
  });
});

describe("professional tax", () => {
  const pt = (s: StateCode, gross: number, month = 6, extra: Partial<Parameters<typeof professionalTax>[0]> = {}) => professionalTax({ config: PT(s), month, grossPaise: r(gross), ...extra }).amountPaise;
  const year = (s: StateCode, gross: number, months = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3], extra = {}) => {
    let ytd = 0;
    for (const m of months) ytd += professionalTax({ config: PT(s), month: m, grossPaise: r(gross), ytdPaise: ytd, ...extra }).amountPaise;
    return ytd;
  };
  it("Karnataka: ₹200 from ₹25,000, ₹300 in February", () => {
    expect([pt("KA", 24_999), pt("KA", 25_000), pt("KA", 25_000, 2)]).toEqual([0, r(200), r(300)]);
    expect(year("KA", 40_000)).toBe(r(2_500));
  });
  it("yearly cap trims February", () => {
    expect(professionalTax({ config: PT("KA"), month: 2, grossPaise: r(30_000), ytdPaise: r(2_400) })).toMatchObject({ amountPaise: r(100), slabAmountPaise: r(300), capped: true });
    expect(professionalTax({ config: PT("KA"), month: 3, grossPaise: r(30_000), ytdPaise: r(2_500) }).amountPaise).toBe(0);
  });
  it("Maharashtra men: boundaries at ₹7,500 and ₹10,000, ₹300 in February, ₹2,500 a year", () => {
    expect([pt("MH", 7_500), pt("MH", 7_501), pt("MH", 10_000), pt("MH", 10_001), pt("MH", 10_001, 2)]).toEqual([0, r(175), r(175), r(200), r(300)]);
    expect(year("MH", 50_000)).toBe(r(2_500));
  });
  it("Maharashtra women have their own table", () => {
    expect([pt("MH", 20_000, 6, { gender: "female" }), pt("MH", 25_000, 6, { gender: "female" }), pt("MH", 30_000, 6, { gender: "female" }), pt("MH", 30_000, 2, { gender: "female" })]).toEqual([0, 0, r(200), r(300)]);
    expect(pt("MH", 20_000, 6, { gender: "other" })).toBe(r(200));
  });
  it("Maharashtra mid-year joiner (October): ₹1,300 for the year", () => {
    expect(year("MH", 50_000, [10, 11, 12, 1, 2, 3])).toBe(r(1_300));
  });
  it("Tamil Nadu: half-yearly, only in September and March", () => {
    expect(professionalTax({ config: PT("TN"), month: 7, grossPaise: r(30_000) })).toMatchObject({ amountPaise: 0, dueThisMonth: false });
    expect(pt("TN", 30_000, 9, { periodGrossPaise: r(180_000) })).toBe(r(1_250));
    expect(pt("TN", 6_000, 3)).toBe(r(425));          // 6,000 × 6 = 36,000
    expect(pt("TN", 3_500, 9)).toBe(0);               // 21,000 for the half year
    expect(pt("TN", 3_501, 9)).toBe(r(180));
    expect(year("TN", 100_000)).toBe(r(2_500));
  });
  it("West Bengal slabs", () => {
    expect([pt("WB", 10_000), pt("WB", 12_000), pt("WB", 20_000), pt("WB", 40_000), pt("WB", 40_001)]).toEqual([0, r(110), r(130), r(150), r(200)]);
  });
  it("Andhra Pradesh and Telangana", () => {
    expect([pt("AP", 15_000), pt("AP", 18_000), pt("AP", 20_001), pt("TS", 15_001), pt("TS", 50_000)]).toEqual([0, r(150), r(200), r(150), r(200)]);
  });
  it("Gujarat: ₹200 from ₹12,000", () => {
    expect([pt("GJ", 11_999), pt("GJ", 12_000)]).toEqual([0, r(200)]);
  });
  it("Madhya Pradesh: February balances the year to the annual amount", () => {
    expect([pt("MP", 18_000), pt("MP", 20_000), pt("MP", 30_000), pt("MP", 30_000, 2), pt("MP", 50_000, 2)]).toEqual([0, r(125), r(166), r(174), r(212)]);
    expect([year("MP", 20_000), year("MP", 30_000), year("MP", 50_000)]).toEqual([r(1_500), r(2_000), r(2_500)]);
  });
  it("refuses a month outside 1–12", () => {
    expect(() => pt("KA", 30_000, 13)).toThrow(RangeError);
  });
});

describe("LWF", () => {
  it("Maharashtra: June and December, lower slab up to ₹3,000", () => {
    expect(lwf({ config: LWF("MH"), month: 6, grossPaise: r(2_500) })).toEqual({ employeePaise: r(6), employerPaise: r(18), dueThisMonth: true });
    expect(lwf({ config: LWF("MH"), month: 12, grossPaise: r(30_000) })).toMatchObject({ employeePaise: r(25), employerPaise: r(75) });
    expect(lwf({ config: LWF("MH"), month: 7, grossPaise: r(30_000) })).toEqual({ employeePaise: 0, employerPaise: 0, dueThisMonth: false });
  });
  it("Karnataka yearly in December", () => {
    expect(lwf({ config: LWF("KA"), month: 12, grossPaise: r(30_000) })).toMatchObject({ employeePaise: r(50), employerPaise: r(100) });
    expect(lwf({ config: LWF("KA"), month: 11, grossPaise: r(30_000) }).employeePaise).toBe(0);
  });
  it("other states", () => {
    expect(lwf({ config: LWF("WB"), month: 6, grossPaise: r(30_000) })).toMatchObject({ employeePaise: r(3), employerPaise: r(15) });
    expect(lwf({ config: LWF("GJ"), month: 12, grossPaise: r(30_000) })).toMatchObject({ employeePaise: r(6), employerPaise: r(12) });
    expect(lwf({ config: LWF("TS"), month: 12, grossPaise: r(30_000) })).toMatchObject({ employeePaise: r(2), employerPaise: r(5) });
  });
  it("nothing on a month with no wages", () => {
    expect(lwf({ config: LWF("MP"), month: 6, grossPaise: 0 })).toMatchObject({ employeePaise: 0, employerPaise: 0 });
  });
});

describe("gratuity", () => {
  const g = (wage: number, join: string, lwd: string, extra: Partial<Parameters<typeof gratuity>[0]> = {}) => gratuity({ config: GR, lastMonthlyWagePaise: r(wage), joiningDate: join, lastWorkingDate: lwd, ...extra });
  it("service length counts the last working day", () => {
    expect(serviceLength("2020-01-01", "2024-12-31")).toEqual({ years: 5, months: 0, days: 0 });
    expect(serviceLength("2020-01-15", "2020-02-13")).toEqual({ years: 0, months: 0, days: 30 });
    expect(serviceLength("2019-03-10", "2024-09-09")).toEqual({ years: 5, months: 6, days: 0 });
    expect(() => serviceLength("2020-01-02", "2020-01-01")).toThrow();
  });
  it("ten years on ₹50,000: 15/26 × 50,000 × 10", () => {
    expect(g(50_000, "2015-04-01", "2025-03-31")).toMatchObject({ eligible: true, countedYears: 10, formulaPaise: r(288_462), amountPaise: r(288_462) });
  });
  it("4 years 11 months: not eligible on resignation", () => {
    expect(g(50_000, "2020-01-01", "2024-11-30")).toMatchObject({ eligible: false, completedYears: 4, extraMonths: 11, amountPaise: 0 });
  });
  it("exactly five years is eligible", () => {
    expect(g(52_000, "2020-01-01", "2024-12-31")).toMatchObject({ eligible: true, countedYears: 5, amountPaise: r(150_000) });
  });
  it("a part year counts only when it is more than six months", () => {
    expect(g(26_000, "2018-01-01", "2023-06-30")).toMatchObject({ completedYears: 5, extraMonths: 6, countedYears: 5, amountPaise: r(75_000) });
    expect(g(26_000, "2018-01-01", "2023-07-01")).toMatchObject({ countedYears: 6, amountPaise: r(90_000) });
  });
  it("₹20 lakh ceiling", () => {
    const x = g(300_000, "1995-01-01", "2024-12-31");
    expect(x.formulaPaise).toBe(r(5_192_308));
    expect(x.amountPaise).toBe(r(20 * L));
    expect(x.exemptPaise).toBe(r(20 * L));
  });
  it("death or disablement: no five-year minimum", () => {
    expect(g(40_000, "2022-01-01", "2023-12-31", { reason: "death" })).toMatchObject({ eligible: true, countedYears: 2, amountPaise: r(46_154) });
    expect(g(40_000, "2022-01-01", "2023-12-31", { reason: "termination" }).eligible).toBe(false);
  });
  it("fixed-term staff: one year", () => {
    expect(g(26_000, "2024-01-01", "2025-02-28", { fixedTerm: true })).toMatchObject({ eligible: true, countedYears: 1, amountPaise: r(15_000) });
    expect(g(26_000, "2024-06-01", "2025-02-28", { fixedTerm: true }).eligible).toBe(false);
  });
});

describe("income tax FY 2025-26, new regime", () => {
  const t = (gross: number, extra: Partial<Parameters<typeof annualTax>[0]> = {}) => annualTax({ config: NEW, grossIncomePaise: r(gross), ...extra });
  it("₹12.75 lakh salary: zero after the standard deduction and rebate", () => {
    expect(t(1_275_000)).toMatchObject({ taxableIncomePaise: r(12 * L), slabTaxPaise: r(60_000), rebatePaise: r(60_000), totalTaxPaise: 0 });
  });
  it("rebate cliff smoothed by marginal relief: ₹10 over the limit costs ₹10", () => {
    expect(t(1_275_010)).toMatchObject({ taxableIncomePaise: r(1_200_010), slabTaxPaise: 6_000_150, rebatePaise: 6_000_150 - r(10), totalTaxPaise: r(10) });
  });
  it("marginal relief at ₹12.10 lakh taxable", () => {
    expect(t(1_285_000)).toMatchObject({ slabTaxPaise: r(61_500), rebatePaise: r(51_500), cessPaise: r(400), totalTaxPaise: r(10_400) });
  });
  it("past the relief zone (₹12.75 lakh taxable): full slab tax", () => {
    expect(t(1_350_000)).toMatchObject({ slabTaxPaise: r(71_250), rebatePaise: 0, cessPaise: r(2_850), totalTaxPaise: r(74_100) });
  });
  it("₹25 lakh: every slab", () => {
    expect(t(2_500_000)).toMatchObject({ taxableIncomePaise: r(2_425_000), slabTaxPaise: r(307_500), totalTaxPaise: r(319_800) });
  });
  it("₹60 lakh taxable: 10% surcharge", () => {
    expect(t(6_075_000)).toMatchObject({ slabTaxPaise: r(1_380_000), surchargePaise: r(138_000), cessPaise: r(60_720), totalTaxPaise: r(1_578_720) });
  });
  it("just over ₹50 lakh: surcharge marginal relief", () => {
    expect(t(5_085_000)).toMatchObject({ taxableIncomePaise: r(5_010_000), slabTaxPaise: r(1_083_000), surchargePaise: r(7_000), totalTaxPaise: r(1_133_600) });
  });
  it("surcharge stops at 25% in the new regime", () => {
    expect(t(60_075_000)).toMatchObject({ slabTaxPaise: r(17_580_000), surchargePaise: r(4_395_000), totalTaxPaise: r(22_854_000) });
  });
  it("only employer NPS counts as a deduction", () => {
    expect(t(1_325_000, { deductions: { employerNpsPaise: r(50_000), section80CPaise: r(150_000) } })).toMatchObject({ deductionsPaise: r(50_000), taxableIncomePaise: r(12 * L), totalTaxPaise: 0 });
  });
  it("no salary: no standard deduction beyond the income, no tax", () => {
    expect(t(50_000)).toMatchObject({ standardDeductionPaise: r(50_000), taxableIncomePaise: 0, totalTaxPaise: 0 });
    expect(t(500_000, { standardDeduction: false })).toMatchObject({ taxableIncomePaise: r(500_000), slabTaxPaise: r(5_000), rebatePaise: r(5_000) });
  });
});

describe("income tax FY 2025-26, old regime", () => {
  const t = (gross: number, extra: Partial<Parameters<typeof annualTax>[0]> = {}) => annualTax({ config: OLD, grossIncomePaise: r(gross), ...extra });
  it("₹5 lakh taxable: rebate wipes out the tax", () => {
    expect(t(550_000)).toMatchObject({ taxableIncomePaise: r(500_000), slabTaxPaise: r(12_500), rebatePaise: r(12_500), totalTaxPaise: 0 });
  });
  it("rebate cliff with no marginal relief: ₹10 more income costs ₹13,000", () => {
    expect(t(550_010)).toMatchObject({ slabTaxPaise: r(12_502), rebatePaise: 0, totalTaxPaise: r(13_000) });
  });
  it("deductions with caps (80C ₹1.5 lakh)", () => {
    const d = { section80CPaise: r(200_000), otherChapterVIAPaise: r(25_000), hraExemptPaise: r(120_000), professionalTaxPaise: r(2_500) };
    expect(t(1_500_000, { deductions: d })).toMatchObject({ deductionsPaise: r(297_500), taxableIncomePaise: r(1_152_500), slabTaxPaise: r(158_250), totalTaxPaise: r(164_580) });
  });
  it("home loan interest capped at ₹2 lakh", () => {
    expect(t(1_000_000, { deductions: { homeLoanInterestPaise: r(350_000) } }).deductionsPaise).toBe(r(200_000));
  });
  it("seniors and super seniors have a higher exemption", () => {
    expect(t(1_100_000).totalTaxPaise).toBe(r(132_600));
    expect(t(1_100_000, { ageBand: "senior" }).totalTaxPaise).toBe(r(130_000));
    expect(t(1_100_000, { ageBand: "super_senior" }).totalTaxPaise).toBe(r(119_600));
  });
  it("37% surcharge above ₹5 crore", () => {
    expect(t(60_050_000)).toMatchObject({ slabTaxPaise: r(17_812_500), surchargePaise: r(6_590_625), totalTaxPaise: r(25_379_250) });
  });
  it("regime comparison picks the lower tax", () => {
    const d = { section80CPaise: r(200_000), otherChapterVIAPaise: r(25_000), hraExemptPaise: r(120_000), professionalTaxPaise: r(2_500) };
    const c = compareRegimes({ oldConfig: OLD, newConfig: NEW, grossIncomePaise: r(1_500_000), deductions: d });
    expect([c.old.totalTaxPaise, c.new.totalTaxPaise, c.better, c.savingPaise]).toEqual([r(164_580), r(97_500), "new", r(67_080)]);
  });
});

describe("income tax FY 2026-27 (assumed same as 2025-26)", () => {
  it("same result as the previous year for both regimes", () => {
    for (const gross of [r(900_000), r(1_285_000), r(2_500_000), r(5_085_000)]) {
      expect({ ...annualTax({ config: NEW27, grossIncomePaise: gross }), fy: "" }).toEqual({ ...annualTax({ config: NEW, grossIncomePaise: gross }), fy: "" });
      expect({ ...annualTax({ config: OLD27, grossIncomePaise: gross }), fy: "" }).toEqual({ ...annualTax({ config: OLD, grossIncomePaise: gross }), fy: "" });
    }
  });
  it("slab tax is the same as summing slabs by hand", () => {
    expect(slabTax(NEW27.slabs.below_60, r(16 * L))).toBe(r(120_000));
  });
});

describe("financial year helpers", () => {
  it("FY boundaries and months left", () => {
    expect([fyOf("2026-03-31"), fyOf("2026-04-01"), fyOf("2099-12-01")]).toEqual(["2025-26", "2026-27", "2099-00"]);
    expect(fyRange("2025-26")).toEqual({ from: "2025-04-01", to: "2026-03-31" });
    expect([remainingMonthsInFy("2025-04-30"), remainingMonthsInFy("2025-12-01"), remainingMonthsInFy("2026-03-15")]).toEqual([12, 4, 1]);
  });
});

describe("monthly TDS projection", () => {
  const base = { fy: "2025-26", regime: "new" as const, config: NEW, tdsDeductedPaise: 0, ytdTaxablePaise: 0 };
  it("April, ₹18 lakh a year: annual tax over 12 months", () => {
    const x = projectTds({ ...base, projectedTaxablePaise: r(1_800_000), remainingMonths: 12 });
    expect([x.annual.totalTaxPaise, x.monthlyTdsPaise]).toEqual([r(150_800), r(12_567)]);
  });
  it("October joiner: only six months of income here, under the rebate limit", () => {
    const x = projectTds({ ...base, projectedTaxablePaise: r(900_000), remainingMonths: 6 });
    expect([x.annualIncomePaise, x.annual.totalTaxPaise, x.monthlyTdsPaise]).toEqual([r(900_000), 0, 0]);
  });
  it("mid-year raise: the shortfall is spread over the months left", () => {
    const x = projectTds({ ...base, ytdTaxablePaise: r(900_000), projectedTaxablePaise: r(1_200_000), tdsDeductedPaise: r(75_402), remainingMonths: 6 });
    expect([x.annual.totalTaxPaise, x.remainingTaxPaise, x.monthlyTdsPaise]).toEqual([r(214_500), r(139_098), r(23_183)]);
  });
  it("over-deducted: nothing more, and the excess is reported", () => {
    const x = projectTds({ ...base, projectedTaxablePaise: r(1_800_000), tdsDeductedPaise: r(200_000), remainingMonths: 3 });
    expect([x.monthlyTdsPaise, x.excessDeductedPaise]).toEqual([0, r(49_200)]);
  });
  it("March: the whole balance, to the paisa", () => {
    const x = projectTds({ ...base, projectedTaxablePaise: r(1_800_000), tdsDeductedPaise: 13_822_550, remainingMonths: 1 });
    expect(x.monthlyTdsPaise).toBe(r(150_800) - 13_822_550);
  });
  it("old regime with declarations", () => {
    const x = projectTds({ ...base, regime: "old", config: OLD, projectedTaxablePaise: r(1_500_000), remainingMonths: 12,
      deductions: { section80CPaise: r(150_000), otherChapterVIAPaise: r(25_000), hraExemptPaise: r(120_000), professionalTaxPaise: r(2_500) } });
    expect([x.annual.totalTaxPaise, x.monthlyTdsPaise]).toEqual([r(164_580), r(13_715)]);
  });
  it("rates for the wrong year or regime are refused", () => {
    expect(() => projectTds({ ...base, fy: "2026-27", projectedTaxablePaise: r(1), remainingMonths: 12 })).toThrow(/FY 2025-26/);
    expect(() => projectTds({ ...base, regime: "old", projectedTaxablePaise: r(1), remainingMonths: 12 })).toThrow(RangeError);
    expect(() => projectTds({ ...base, projectedTaxablePaise: r(1), remainingMonths: 0 })).toThrow(/1–12/);
  });
});
