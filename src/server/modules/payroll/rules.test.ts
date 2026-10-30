import { describe, expect, it } from "vitest";
import { analyseStructure, arrearsFromMonth, cellToISODate, cellToPaise, computeBreakup, isAccountNumber, isIfsc, isUan, type StructureDef } from "./rules";

const L = (code: string, calc: StructureDef["lines"][number]["calc"], v?: string | number | null, kind: StructureDef["lines"][number]["kind"] = "earning") =>
  ({ code, name: code, kind, calc, value: calc === "formula" ? null : v ?? null, formula: calc === "formula" ? String(v) : null });

/** The default structure erp seeds: Basic 50% of CTC, HRA 40% of Basic, PF employer 12% of Basic up to ₹15,000, Special balances. */
const DEFAULT: StructureDef = { lines: [
  L("BASIC", "pct_ctc", "50"),
  L("HRA", "formula", "[BASIC] * 0.4"),
  L("PF_EMPLOYER", "formula", "min([BASIC], 15000) * 0.12", "employer_contribution"),
  L("SPECIAL", "balancing"),
] };

const rupees = (p: number) => p / 100;
const golden = (s: StructureDef, annualRupees: number) => {
  const b = computeBreakup(s, annualRupees * 100);
  if (!b.ok) throw new Error(b.errors.map((e) => e.message).join("; "));
  return { monthly: rupees(b.monthlyCtcPaise), gross: rupees(b.grossMonthlyPaise), ...Object.fromEntries(b.lines.map((l) => [l.code, rupees(l.monthlyPaise)])) };
};

describe("computeBreakup (golden cases)", () => {
  it.each([
    // annual CTC → monthly lines (₹). Basic and HRA round to whole rupees; Special absorbs the remainder.
    [600000, { monthly: 50000, gross: 48200, BASIC: 25000, HRA: 10000, PF_EMPLOYER: 1800, SPECIAL: 13200 }],
    [1200000, { monthly: 100000, gross: 98200, BASIC: 50000, HRA: 20000, PF_EMPLOYER: 1800, SPECIAL: 28200 }],
    [300000, { monthly: 25000, gross: 23500, BASIC: 12500, HRA: 5000, PF_EMPLOYER: 1500, SPECIAL: 6000 }],
    // 1,000,001 / 12 = 83,333.4166… → monthly 83,333.42; Basic 41,666.71 → 41,667; HRA 16,666.8 → 16,667
    [1000001, { monthly: 83333.42, gross: 81533.42, BASIC: 41667, HRA: 16667, PF_EMPLOYER: 1800, SPECIAL: 23199.42 }],
    // 3,50,005 / 12 = 29,167.0833… → 29,167.08; Basic 14,583.54 → 14,584; HRA 5,833.6 → 5,834; PF 1,750.08 → 1,750; Special 6,999.08
    [350005, { monthly: 29167.08, gross: 27417.08, BASIC: 14584, HRA: 5834, PF_EMPLOYER: 1750, SPECIAL: 6999.08 }],
  ])("CTC ₹%i", (ctc, expected) => {
    expect(golden(DEFAULT, ctc)).toEqual(expected);
  });

  it("monthly lines always add up to monthly CTC exactly", () => {
    for (const ctc of [180000, 250013, 499999, 777777, 1234567, 9999999, 25000000]) {
      const b = computeBreakup(DEFAULT, ctc * 100 + (ctc % 97));
      if (!b.ok) throw new Error("not ok");
      expect(b.lines.reduce((t, l) => t + l.monthlyPaise, 0)).toBe(b.monthlyCtcPaise);
      expect(b.lines.filter((l) => l.code !== "SPECIAL").every((l) => l.monthlyPaise % 100 === 0)).toBe(true);
      expect(b.breakup.BASIC).toBe(b.lines[0].monthlyPaise);
    }
  });

  it("supports flat amounts, % of gross and evaluation in dependency order (lines in any order)", () => {
    const s: StructureDef = { lines: [
      L("SPECIAL", "balancing"),
      L("HRA", "formula", "[BASIC] / 2"),
      L("CONV", "flat", "1600"),
      L("BASIC", "pct_gross", "40"),
      L("GRATUITY", "formula", "round([BASIC] * 15 / 26 / 12)", "employer_contribution"),
    ] };
    // monthly CTC 1,00,000; gratuity depends on BASIC which depends on GROSS which depends on GRATUITY → cycle
    const b = computeBreakup(s, 12_00_000_00);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.errors[0].message).toMatch(/Circular reference.*GROSS/);

    const s2: StructureDef = { lines: [L("SPECIAL", "balancing"), L("HRA", "formula", "[BASIC] / 2"), L("CONV", "flat", "1600"), L("BASIC", "pct_gross", "40"), L("PF_EMPLOYER", "flat", "1800", "employer_contribution")] };
    expect(golden(s2, 1200000)).toEqual({ monthly: 100000, gross: 98200, SPECIAL: 37680, HRA: 19640, CONV: 1600, BASIC: 39280, PF_EMPLOYER: 1800 });
  });

  it("finds circular references, unknown codes, missing or extra balancing lines", () => {
    const msg = (s: StructureDef) => analyseStructure(s).issues.map((i) => i.message).join(" | ");
    expect(msg({ lines: [L("A", "formula", "[B] + 1"), L("B", "formula", "[A] * 2"), L("S", "balancing")] })).toMatch(/Circular reference: \[A\] → \[B\] → \[A\]|Circular reference: \[B\] → \[A\] → \[B\]/);
    expect(msg({ lines: [L("A", "formula", "[A] + 1"), L("S", "balancing")] })).toMatch(/Circular reference: \[A\] → \[A\]/);
    expect(msg({ lines: [L("A", "formula", "[S] * 0.1"), L("S", "balancing")] })).toMatch(/Circular reference/);
    expect(msg({ lines: [L("A", "formula", "[NOPE] * 0.1"), L("S", "balancing")] })).toMatch(/\[NOPE\], which isn't on this structure/);
    expect(msg({ lines: [L("A", "pct_ctc", "50")] })).toMatch(/balancing line/);
    expect(msg({ lines: [L("A", "balancing"), L("B", "balancing")] })).toMatch(/Only one line/);
    expect(msg({ lines: [L("A", "pct_ctc", "120"), L("S", "balancing")] })).toMatch(/more than 100/);
    expect(msg({ lines: [L("A", "flat", null), L("S", "balancing")] })).toMatch(/monthly amount/);
    expect(msg({ lines: [L("A", "flat", "10", "deduction"), L("S", "balancing")] })).toMatch(/part of CTC/);
    expect(msg({ lines: [L("A", "pct_ctc", "10"), L("S", "balancing", null, "employer_contribution")] })).toMatch(/must be an earning/);
    expect(msg({ lines: [L("A", "pct_ctc", "10"), L("A", "flat", "1"), L("S", "balancing")] })).toMatch(/appears twice/);
    expect(msg({ lines: [] })).toMatch(/at least one/);
    expect(msg(DEFAULT)).toBe("");
  });

  it("refuses a CTC too low for the structure, zero, and runtime division by zero", () => {
    const s: StructureDef = { lines: [L("BASIC", "flat", "20000"), L("S", "balancing")] };
    const low = computeBreakup(s, 1_20_000_00);
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.errors[0].message).toMatch(/too low/);
    expect(computeBreakup(DEFAULT, 0).ok).toBe(false);
    expect(computeBreakup(DEFAULT, -5).ok).toBe(false);
    expect(computeBreakup(DEFAULT, 1.5).ok).toBe(false);
    const z = computeBreakup({ lines: [L("A", "formula", "[CTC] / ([CTC] - [CTC])"), L("S", "balancing")] }, 12_00_000_00);
    expect(z.ok).toBe(false);
    if (!z.ok) expect(z.errors[0].message).toMatch(/Division by zero/);
  });

  it("is deterministic", () => {
    const a = computeBreakup(DEFAULT, 987654321), b = computeBreakup(DEFAULT, 987654321);
    expect(a).toEqual(b);
  });
});

describe("arrearsFromMonth", () => {
  it("flags backdated revisions from the month they start", () => {
    expect(arrearsFromMonth("2026-08-15", "2026-10-30")).toBe("2026-08-01");
    expect(arrearsFromMonth("2026-10-01", "2026-10-30")).toBeNull();
    expect(arrearsFromMonth("2026-12-01", "2026-10-30")).toBeNull();
    expect(arrearsFromMonth("2026-10-05", "2026-10-30", ["2026-10-01"])).toBe("2026-10-01");
    expect(arrearsFromMonth("2026-11-01", "2026-10-30", ["2026-10-01"])).toBeNull();
  });
});

describe("field validation and spreadsheet cells", () => {
  it("IFSC, account number, UAN", () => {
    expect(isIfsc("HDFC0001234")).toBe(true);
    expect(isIfsc("hdfc 0001234")).toBe(true);
    expect(isIfsc("HDFC1001234")).toBe(false);
    expect(isIfsc("HDF00001234")).toBe(false);
    expect(isAccountNumber("123456789")).toBe(true);
    expect(isAccountNumber("1234 5678 9012")).toBe(true);
    expect(isAccountNumber("12345678")).toBe(false);
    expect(isAccountNumber("12345678901234567890")).toBe(false);
    expect(isUan("100200300400")).toBe(true);
    expect(isUan("10020030040")).toBe(false);
  });
  it("money and dates from cells", () => {
    expect(cellToPaise(1200000)).toBe(120000000);
    expect(cellToPaise("12,00,000.50")).toBe(120000050);
    expect(cellToPaise("₹ 5,00,000")).toBe(50000000);
    expect(cellToPaise("1.234")).toBeNull();
    expect(cellToPaise(-5)).toBeNull();
    expect(cellToPaise("abc")).toBeNull();
    expect(cellToPaise(1e21)).toBeNull();
    expect(cellToISODate(new Date(Date.UTC(2026, 3, 1)))).toBe("2026-04-01");
    expect(cellToISODate("2026-04-01")).toBe("2026-04-01");
    expect(cellToISODate("01/04/2026")).toBe("2026-04-01");
    expect(cellToISODate("31/02/2026")).toBeNull();
    expect(cellToISODate("April")).toBeNull();
  });
});
