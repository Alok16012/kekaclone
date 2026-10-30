import { describe, expect, it } from "vitest";
import {
  canMove, categoryProblem, checkLine, csvAmount, divRound, inr, mileagePaise, parseHalfDays, parseKm, parseRupees, perDiemPaise,
  schedulableMonth, settleAgainstAdvance, summarize, toCsv, upcomingMonths, violationText, isBlocking,
  type Category, type Line,
} from "./rules";

describe("parsing money", () => {
  it.each([
    ["1234", 123400], ["1,234.5", 123450], ["₹ 12,34,567.89", 123456789], ["0.05", 5], ["7.", 700], ["0", 0],
  ])("%s → %d paise", (s, p) => expect(parseRupees(s)).toBe(p));
  it.each(["", "-5", "1.234", "abc", "1e5", "12.3.4", "9999999999999"])("rejects %j", (s) => expect(parseRupees(s)).toBeNull());
  it("null stays null", () => expect(parseRupees(null)).toBeNull());
  it("km in hundredths, at most two decimals", () => {
    expect(parseKm("12.5")).toBe(1250); expect(parseKm("0.01")).toBe(1); expect(parseKm("100000")).toBeNull(); expect(parseKm("1.005")).toBeNull();
  });
  it("per-diem days in halves", () => {
    expect(parseHalfDays("1.5")).toBe(3); expect(parseHalfDays("2")).toBe(4); expect(parseHalfDays("0.5")).toBe(1);
    expect(parseHalfDays("0")).toBeNull(); expect(parseHalfDays("1.25")).toBeNull(); expect(parseHalfDays("32")).toBeNull();
  });
});

describe("amounts (golden values, integer paise, half up)", () => {
  it("divRound rounds half up", () => { expect(divRound(5, 10)).toBe(1); expect(divRound(4, 10)).toBe(0); expect(divRound(15, 10)).toBe(2); expect(divRound(25, 10)).toBe(3); });
  it.each([
    // km (hundredths), rate paise/km, expected paise
    [1250, 900, 11250],      // 12.5 km × ₹9 = ₹112.50
    [1, 950, 10],            // 0.01 km × ₹9.50 = 9.5 paise → 10
    [333, 1000, 3330],
    [12345, 1275, 157399],   // 123.45 × 12.75 = 1573.9875 → ₹1,573.99
    [0, 900, 0],
  ])("mileage %d × %d = %d", (km, rate, want) => expect(mileagePaise(km, rate)).toBe(want));
  it.each([
    [3, 120000, 180000],     // 1.5 days × ₹1,200
    [1, 99999, 50000],       // half of ₹999.99 = 49,999.5 paise → 50,000
    [62, 150000, 4650000],
  ])("per diem %d halves × %d = %d", (h, rate, want) => expect(perDiemPaise(h, rate)).toBe(want));
  it("formats rupees in Indian grouping", () => expect(inr(123456789)).toBe("₹12,34,567.89"));
  it("csv amounts are exact", () => { expect(csvAmount(5)).toBe("0.05"); expect(csvAmount(123450)).toBe("1234.50"); expect(csvAmount(-700)).toBe("-7.00"); });
});

describe("category setup", () => {
  const base = { name: "Meals", kind: "general" as const, limitPaise: null, limitPeriod: null, ratePerKmPaise: null, receiptAbovePaise: null, glCode: null };
  it("a plain category is fine", () => expect(categoryProblem(base)).toBeNull());
  it("needs a name", () => expect(categoryProblem({ ...base, name: " " })?.field).toBe("name"));
  it("a limit needs a period", () => expect(categoryProblem({ ...base, limitPaise: 100 })?.field).toBe("limitPeriod"));
  it("mileage needs a rate", () => expect(categoryProblem({ ...base, kind: "mileage" })?.field).toBe("ratePerKmPaise"));
  it("per diem needs a daily allowance", () => {
    expect(categoryProblem({ ...base, kind: "per_diem", limitPaise: 100, limitPeriod: "month" })?.field).toBe("limitPaise");
    expect(categoryProblem({ ...base, kind: "per_diem", limitPaise: 100, limitPeriod: "day" })).toBeNull();
  });
  it("GL codes are short and plain", () => { expect(categoryProblem({ ...base, glCode: "6100-01" })).toBeNull(); expect(categoryProblem({ ...base, glCode: "=cmd()" })?.field).toBe("glCode"); });
});

describe("policy checks", () => {
  const cat = (over: Partial<Category> = {}): Category => ({ id: "c1", name: "Meals", kind: "general", limit_paise: null, limit_period: null, rate_per_km_paise: null, receipt_required_above_paise: null, gl_code: null, ...over });
  const line = (over: Partial<Line> = {}): Line => ({ id: "l1", categoryId: "c1", claimId: null, spentOn: "2026-10-20", amountPaise: 50000, receipts: 0, merchant: "Cafe", ...over });
  const policy = { allowFutureDated: false, submissionDeadlineDays: 60 };
  const today = "2026-10-30";

  it("receipt needed only above the threshold", () => {
    expect(checkLine(line(), cat({ receipt_required_above_paise: 50000 }), policy, today, [])).toEqual([]);
    expect(checkLine(line({ amountPaise: 50001 }), cat({ receipt_required_above_paise: 50000 }), policy, today, [])).toEqual(["receipt_missing"]);
    expect(checkLine(line({ amountPaise: 50001, receipts: 1 }), cat({ receipt_required_above_paise: 50000 }), policy, today, [])).toEqual([]);
    expect(checkLine(line({ amountPaise: 1 }), cat({ receipt_required_above_paise: 0 }), policy, today, [])).toEqual(["receipt_missing"]);
  });
  it("future dates unless the policy allows them", () => {
    expect(checkLine(line({ spentOn: "2026-10-31" }), cat(), policy, today, [])).toEqual(["future_dated"]);
    expect(checkLine(line({ spentOn: "2026-10-31" }), cat(), { ...policy, allowFutureDated: true }, today, [])).toEqual([]);
  });
  it("late after the deadline (exactly on the deadline is fine)", () => {
    expect(checkLine(line({ spentOn: "2026-08-31" }), cat(), policy, today, [])).toEqual([]);
    expect(checkLine(line({ spentOn: "2026-08-30" }), cat(), policy, today, [])).toEqual(["late"]);
    expect(checkLine(line({ spentOn: "2020-01-01" }), cat(), { ...policy, submissionDeadlineDays: null }, today, [])).toEqual([]);
  });
  it("per-day limit adds the day's other lines in the category", () => {
    const c = cat({ limit_paise: 100000, limit_period: "day" });
    expect(checkLine(line(), c, policy, today, [line({ id: "l2", merchant: "Dhaba" })])).toEqual([]);                       // 500 + 500 = limit
    expect(checkLine(line(), c, policy, today, [line({ id: "l2", merchant: "Dhaba", amountPaise: 50001 })])).toEqual(["over_limit_day"]);
    expect(checkLine(line(), c, policy, today, [line({ id: "l2", merchant: "Dhaba", amountPaise: 90000, spentOn: "2026-10-21" })])).toEqual([]);   // other day
    expect(checkLine(line(), c, policy, today, [line({ id: "l2", categoryId: "c2", amountPaise: 90000 })])).toEqual([]);   // other category
  });
  it("monthly, yearly and per-claim windows", () => {
    const other = line({ id: "l2", merchant: "x", spentOn: "2026-10-01", amountPaise: 60000, claimId: "k1" });
    expect(checkLine(line(), cat({ limit_paise: 100000, limit_period: "month" }), policy, today, [other])).toEqual(["over_limit_month"]);
    expect(checkLine(line(), cat({ limit_paise: 100000, limit_period: "year" }), policy, today, [{ ...other, spentOn: "2026-01-05" }])).toEqual(["over_limit_year"]);
    expect(checkLine(line({ claimId: "k1" }), cat({ limit_paise: 100000, limit_period: "claim" }), policy, today, [other])).toEqual(["over_limit_claim"]);
    expect(checkLine(line({ claimId: "k2" }), cat({ limit_paise: 100000, limit_period: "claim" }), policy, today, [other])).toEqual([]);
    expect(checkLine(line({ amountPaise: 100001 }), cat({ limit_paise: 100000, limit_period: "claim" }), policy, today, [])).toEqual(["over_limit_claim"]);
  });
  it("per diem isn't limited by its own daily allowance", () => {
    expect(checkLine(line({ amountPaise: 180000 }), cat({ kind: "per_diem", limit_paise: 120000, limit_period: "day" }), policy, today, [])).toEqual([]);
  });
  it("flags duplicates (merchant compared loosely), never against itself", () => {
    expect(checkLine(line(), cat(), policy, today, [line({ id: "l2", merchant: " cafe " })])).toEqual(["duplicate"]);
    expect(checkLine(line(), cat(), policy, today, [line()])).toEqual([]);
  });
  it("blocking vs warnings, and plain-English messages", () => {
    expect(isBlocking("receipt_missing")).toBe(true); expect(isBlocking("future_dated")).toBe(true);
    expect(isBlocking("over_limit_day")).toBe(false); expect(isBlocking("late")).toBe(false);
    expect(violationText("over_limit_day", { limit_paise: 150000, receipt_required_above_paise: null })).toBe("Over ₹1,500.00 for this category on this day.");
    expect(violationText("receipt_missing", { limit_paise: null, receipt_required_above_paise: 50000 })).toContain("₹500.00");
  });
});

describe("claims", () => {
  it("allowed moves", () => {
    expect(canMove("draft", "submitted")).toBe(true);
    expect(canMove("submitted", "draft")).toBe(true);
    expect(canMove("rejected", "draft")).toBe(true);
    expect(canMove("approved", "paid")).toBe(true);
    expect(canMove("draft", "approved")).toBe(false);
    expect(canMove("paid", "draft")).toBe(false);
    expect(canMove("approved", "draft")).toBe(false);
  });
  it("settles against an advance without going negative", () => {
    expect(settleAgainstAdvance(80000, { amount_paise: 100000, settled_paise: 0 })).toEqual({ applied: 80000, payable: 0, settledAfter: 80000, fullySettled: false });
    expect(settleAgainstAdvance(80000, { amount_paise: 100000, settled_paise: 80000 })).toEqual({ applied: 20000, payable: 60000, settledAfter: 100000, fullySettled: true });
    expect(settleAgainstAdvance(80000, { amount_paise: 100000, settled_paise: 100000 })).toEqual({ applied: 0, payable: 80000, settledAfter: 100000, fullySettled: true });
    expect(settleAgainstAdvance(5000, null)).toEqual({ applied: 0, payable: 5000, settledAfter: 0, fullySettled: false });
  });
});

describe("payroll months", () => {
  it("this month or later, within a year", () => {
    expect(schedulableMonth("2026-10-01", "2026-10-30")).toBeNull();
    expect(schedulableMonth("2026-11-01", "2026-10-30")).toBeNull();
    expect(schedulableMonth("2026-09-01", "2026-10-30")).toMatch(/passed/);
    expect(schedulableMonth("2027-11-01", "2026-10-30")).toMatch(/next year/);
    expect(schedulableMonth("2026-11-15", "2026-10-30")).toMatch(/Pick a month/);
  });
  it("lists upcoming months across the year end", () => expect(upcomingMonths("2026-11-30", 3)).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]));
});

describe("reports and CSV", () => {
  it("totals by category, department and month", () => {
    const s = summarize([
      { category: "Meals", department: "Sales", spentOn: "2026-09-02", amountPaise: 100 },
      { category: "Travel", department: "Sales", spentOn: "2026-10-02", amountPaise: 500 },
      { category: "Meals", department: null, spentOn: "2026-10-05", amountPaise: 250 },
    ]);
    expect(s.totalPaise).toBe(850); expect(s.count).toBe(3);
    expect(s.byCategory).toEqual([{ key: "Travel", totalPaise: 500, count: 1 }, { key: "Meals", totalPaise: 350, count: 2 }]);
    expect(s.byDepartment.map((g) => g.key)).toEqual(["Sales", "No department"]);
    expect(s.byMonth.map((g) => [g.key, g.totalPaise])).toEqual([["2026-09", 100], ["2026-10", 750]]);
  });
  it("escapes quotes, commas, new lines and formula starts", () => {
    expect(toCsv([["a,b", 'say "hi"', "x\ny", "=1+1", "-2", "@x", null, 5]])).toBe('"a,b","say ""hi""","x\ny",\'=1+1,\'-2,\'@x,,5\r\n');
  });
});
