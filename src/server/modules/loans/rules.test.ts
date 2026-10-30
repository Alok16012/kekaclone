import { describe, expect, it } from "vitest";
import {
  addMonths, buildSchedule, checkFirstEmiMonth, checkRequest, defaultFirstEmiMonth, emiFor, flatInterest, outstandingPrincipal,
  planPrepayment, preEmiInterest, rateToBp, scheduleTotals, skipTarget,
} from "./rules";

const L = 100_000_00; // ₹1,00,000 in paise

describe("rates and months", () => {
  it("parses percentages to basis points without floats", () => {
    expect(rateToBp("9.5")).toBe(950);
    expect(rateToBp("9.50")).toBe(950);
    expect(rateToBp("12")).toBe(1200);
    expect(rateToBp("0.07")).toBe(7);
    expect(rateToBp(8.25)).toBe(825);
    expect(rateToBp("-1")).toBeNull();
    expect(rateToBp("100")).toBeNull();
    expect(rateToBp("1.234")).toBeNull();
  });
  it("adds months across years", () => {
    expect(addMonths("2026-11-01", 3)).toBe("2027-02-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(defaultFirstEmiMonth("2026-12-15")).toBe("2027-01-01");
    expect(checkFirstEmiMonth("2026-12-15", "2026-11-01")).toMatch(/can't be before/);
    expect(checkFirstEmiMonth("2026-12-15", "2027-08-01")).toMatch(/within 6 months/);
    expect(checkFirstEmiMonth("2026-12-15", "2026-12-01")).toBeNull();
  });
});

describe("reducing balance (golden)", () => {
  // ₹1,00,000 at 12% a year over 12 months: textbook EMI ≈ ₹8,884.88, rounded to ₹8,885
  const rows = buildSchedule({ principalPaise: L, rateBp: 1200, rateType: "reducing", months: 12, firstMonth: "2026-11-01" });
  it("matches the closed-form EMI to the rupee", () => {
    expect(emiFor({ principalPaise: L, rateBp: 1200, rateType: "reducing", months: 12 })).toBe(8_885_00);
  });
  it("charges 1% a month on the opening balance and repays exactly the principal", () => {
    expect(rows.map((r) => [r.dueMonth, r.principalPaise, r.interestPaise])).toEqual([
      ["2026-11-01", 788500, 100000], ["2026-12-01", 796385, 92115], ["2027-01-01", 804349, 84151], ["2027-02-01", 812392, 76108],
      ["2027-03-01", 820516, 67984], ["2027-04-01", 828721, 59779], ["2027-05-01", 837009, 51491], ["2027-06-01", 845379, 43121],
      ["2027-07-01", 853833, 34667], ["2027-08-01", 862371, 26129], ["2027-09-01", 870995, 17505], ["2027-10-01", 879550, 8796],
    ]);
    const t = scheduleTotals(rows);
    expect(t.principalPaise).toBe(L);
    expect(t.interestPaise).toBe(661_846);
    expect(rows.slice(0, -1).every((r) => r.emiPaise === 8_885_00)).toBe(true);
    expect(rows.at(-1)!.closingPaise).toBe(0);
    for (let i = 1; i < rows.length; i++) expect(rows[i].openingPaise).toBe(rows[i - 1].closingPaise);
  });
  it("a one-month loan is principal plus one month's interest", () => {
    const r = buildSchedule({ principalPaise: 50_000_00, rateBp: 1200, rateType: "reducing", months: 1, firstMonth: "2026-11-01" });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ principalPaise: 50_000_00, interestPaise: 500_00, emiPaise: 50_500_00 });
  });
});

describe("flat rate (golden)", () => {
  it("charges interest on the full principal for the whole tenure", () => {
    // ₹50,000 at 10% flat over 7 months = ₹2,916.67 → ₹2,917 of interest
    expect(flatInterest(50_000_00, 1000, 7)).toBe(2_917_00);
    const rows = buildSchedule({ principalPaise: 50_000_00, rateBp: 1000, rateType: "flat", months: 7, firstMonth: "2026-11-01" });
    expect(rows.map((r) => [r.principalPaise, r.interestPaise])).toEqual([
      [714300, 41700], [714300, 41700], [714300, 41700], [714300, 41700], [714300, 41700], [714300, 41700], [714200, 41500],
    ]);
    expect(scheduleTotals(rows)).toEqual({ principalPaise: 50_000_00, interestPaise: 2_917_00, totalPaise: 52_917_00 });
    expect(emiFor({ principalPaise: 50_000_00, rateBp: 1000, rateType: "flat", months: 7 })).toBe(7_560_00);
  });
});

describe("interest-free", () => {
  it("splits the principal to the rupee, the last EMI takes the paise", () => {
    const rows = buildSchedule({ principalPaise: 10_000_001, rateBp: 0, rateType: "zero", months: 3, firstMonth: "2026-11-01" });
    expect(rows.map((r) => r.principalPaise)).toEqual([3_333_300, 3_333_300, 3_333_401]);
    expect(rows.every((r) => r.interestPaise === 0)).toBe(true);
  });
  it("never lets rounding up overshoot on tiny loans", () => {
    const rows = buildSchedule({ principalPaise: 150_00, rateBp: 0, rateType: "zero", months: 4, firstMonth: "2026-11-01" });
    expect(rows.every((r) => r.principalPaise >= 0)).toBe(true);
    expect(scheduleTotals(rows).principalPaise).toBe(150_00);
  });
  it("treats a flat or reducing loan at 0% as interest-free and ignores a rate on a zero loan", () => {
    expect(scheduleTotals(buildSchedule({ principalPaise: L, rateBp: 0, rateType: "reducing", months: 10, firstMonth: "2026-11-01" })).interestPaise).toBe(0);
    expect(scheduleTotals(buildSchedule({ principalPaise: L, rateBp: 900, rateType: "zero", months: 10, firstMonth: "2026-11-01" })).interestPaise).toBe(0);
  });
  it("rejects bad terms", () => {
    expect(() => buildSchedule({ principalPaise: 0, rateBp: 0, rateType: "zero", months: 3, firstMonth: "2026-11-01" })).toThrow();
    expect(() => buildSchedule({ principalPaise: 100, rateBp: 0, rateType: "zero", months: 0, firstMonth: "2026-11-01" })).toThrow();
    expect(() => buildSchedule({ principalPaise: 100.5, rateBp: 0, rateType: "zero", months: 3, firstMonth: "2026-11-01" })).toThrow();
    expect(() => buildSchedule({ principalPaise: 100, rateBp: 0, rateType: "zero", months: 3, firstMonth: "2026-11-15" })).toThrow();
  });
});

describe("pre-EMI interest", () => {
  it("charges the days before the regular accrual month, simple interest on actual/365", () => {
    // paid out 10 Sep, first EMI in November → regular interest starts 1 Oct; 21 extra days
    expect(preEmiInterest({ principalPaise: L, rateBp: 1200, rateType: "reducing", disbursedOn: "2026-09-10", firstEmiMonth: "2026-11-01" })).toEqual({ days: 21, interestPaise: 69_041 });
    expect(preEmiInterest({ principalPaise: L, rateBp: 1200, rateType: "flat", disbursedOn: "2026-09-10", firstEmiMonth: "2026-11-01" }).interestPaise).toBe(69_041);
  });
  it("is nothing when paid out in the month before the first EMI, or for interest-free loans", () => {
    expect(preEmiInterest({ principalPaise: L, rateBp: 1200, rateType: "reducing", disbursedOn: "2026-10-01", firstEmiMonth: "2026-11-01" }).interestPaise).toBe(0);
    expect(preEmiInterest({ principalPaise: L, rateBp: 1200, rateType: "reducing", disbursedOn: "2026-10-20", firstEmiMonth: "2026-11-01" }).interestPaise).toBe(0);
    expect(preEmiInterest({ principalPaise: L, rateBp: 0, rateType: "zero", disbursedOn: "2026-08-01", firstEmiMonth: "2026-11-01" })).toEqual({ days: 61, interestPaise: 0 });
  });
  it("is added to the first EMI", () => {
    const rows = buildSchedule({ principalPaise: L, rateBp: 1200, rateType: "reducing", months: 12, firstMonth: "2026-11-01", extraFirstInterestPaise: 69_041 });
    expect(rows[0]).toMatchObject({ principalPaise: 788500, interestPaise: 169_041, emiPaise: 957_541 });
    expect(rows[1].emiPaise).toBe(8_885_00);
  });
});

describe("policy limits", () => {
  const c = { name: "Personal", maxAmountPaise: 2_00_000_00, maxTenureMonths: 24 };
  it("checks amount and tenure against the category", () => {
    expect(checkRequest(c, { amountPaise: 1_50_000_00, months: 12 })).toBeNull();
    expect(checkRequest(c, { amountPaise: 2_00_001_00, months: 12 })).toMatchObject({ field: "amount" });
    expect(checkRequest(c, { amountPaise: 1_00_000_00, months: 25 })).toMatchObject({ field: "months" });
    expect(checkRequest(c, { amountPaise: 0, months: 12 })).toMatchObject({ field: "amount" });
    expect(checkRequest({ name: "Any", maxAmountPaise: null, maxTenureMonths: null }, { amountPaise: 5_00_000_00, months: 360 })).toBeNull();
    expect(checkRequest({ name: "Any", maxAmountPaise: null, maxTenureMonths: null }, { amountPaise: 5_00_000_00, months: 361 })).toMatchObject({ field: "months" });
  });
});

describe("skip and prepay", () => {
  const rows = buildSchedule({ principalPaise: 60_000_00, rateBp: 0, rateType: "zero", months: 6, firstMonth: "2026-11-01" })
    .map((r, i) => ({ dueMonth: r.dueMonth, principalPaise: r.principalPaise, interestPaise: r.interestPaise, status: i < 2 ? ("deducted" as const) : ("scheduled" as const) }));
  it("moves a skipped EMI after the last one", () => {
    expect(skipTarget(rows, "2027-02-01")).toEqual({ ok: true, newMonth: "2027-05-01" });
    expect(skipTarget(rows, "2026-11-01")).toMatchObject({ ok: false });
    expect(skipTarget(rows, "2028-01-01")).toMatchObject({ ok: false });
  });
  it("works out principal still owed", () => {
    expect(outstandingPrincipal(60_000_00, rows, 0)).toBe(40_000_00);
    expect(outstandingPrincipal(60_000_00, rows, 15_000_00)).toBe(25_000_00);
    expect(outstandingPrincipal(60_000_00, rows, 99_000_00)).toBe(0);
  });
  it("closes on a full prepayment, refuses too much, and rebuilds the rest over the same months on a part payment", () => {
    const terms = { rateBp: 1200, rateType: "reducing" as const };
    const open = ["2027-02-01", "2027-03-01", "2027-04-01"];
    expect(planPrepayment({ terms, outstandingPaise: 40_000_00, lockedPrincipalPaise: 10_000_00, amountPaise: 30_000_00, openMonths: open })).toEqual({ ok: true, closes: true });
    expect(planPrepayment({ terms, outstandingPaise: 40_000_00, lockedPrincipalPaise: 10_000_00, amountPaise: 30_000_01, openMonths: open })).toMatchObject({ ok: false });
    const p = planPrepayment({ terms, outstandingPaise: 40_000_00, lockedPrincipalPaise: 10_000_00, amountPaise: 15_000_00, openMonths: open });
    expect(p.ok && !p.closes).toBe(true);
    if (p.ok && !p.closes) {
      expect(p.rows.map((r) => r.dueMonth)).toEqual(open);
      expect(scheduleTotals(p.rows).principalPaise).toBe(15_000_00);
      expect(p.rows[0].interestPaise).toBe(15_000); // 1% of ₹15,000
    }
  });
});
