import { describe, expect, it } from "vitest";
import { fbpExemptPaise, fbpItems, fbpLimit, fbpProblem, fbpWindowOpen } from "./fbp-rules";

const R = (r: number) => r * 100;
const comps = [
  { code: "FUEL", name: "Fuel", annualMaxPaise: R(24_000), monthlyPaise: R(3_000), taxable: true },      // limit 24,000 (plan) vs 36,000 (salary)
  { code: "PHONE", name: "Phone", annualMaxPaise: null, monthlyPaise: R(1_000), taxable: true },         // limit 12,000 (salary)
  { code: "MEAL", name: "Meal vouchers", annualMaxPaise: R(26_400), monthlyPaise: 0, taxable: false },   // not in this person's salary: the plan's limit applies
  { code: "LTA", name: "Leave travel", annualMaxPaise: R(50_000), monthlyPaise: 0, taxable: true },        // taxable but not in the salary: nothing to exempt
];

describe("flexible benefit plan", () => {
  it("limits a component to the lower of the plan's cap and a year of it in the salary", () => {
    expect(fbpLimit(comps[0])).toBe(R(24_000)); expect(fbpLimit(comps[1])).toBe(R(12_000)); expect(fbpLimit(comps[2])).toBe(R(26_400)); expect(fbpLimit(comps[3])).toBe(0);
  });
  it("refuses unknown components, negative and over-limit amounts", () => {
    expect(fbpProblem({ FUEL: R(24_000), PHONE: R(12_000) }, comps)).toBeNull();
    expect(fbpProblem({ LTC: 1 }, comps)?.code).toBe("LTC");
    expect(fbpProblem({ FUEL: -1 }, comps)?.message).toMatch(/zero or more/);
    expect(fbpProblem({ FUEL: R(24_001) }, comps)?.message).toMatch(/at most ₹24,000 a year \(the plan's limit\)/);
    expect(fbpProblem({ PHONE: R(12_001) }, comps)?.message).toMatch(/what your salary carries/);
    expect(fbpProblem({ FUEL: 1.5 }, comps)?.message).toMatch(/whole paise/);
  });
  it("lists every component with the capped declared amount and counts only taxable ones as exemption", () => {
    const rows = fbpItems({ FUEL: R(30_000), MEAL: R(5_000) }, comps);
    expect(rows.map((r) => [r.code, r.limitPaise, r.declaredPaise, r.countedPaise])).toEqual([["FUEL", R(24_000), R(24_000), R(24_000)], ["PHONE", R(12_000), 0, 0], ["MEAL", R(26_400), R(5_000), 0], ["LTA", 0, 0, 0]]);
    expect(fbpExemptPaise(rows)).toBe(R(24_000));
  });
  it("opens and closes the declaration window inside the financial year", () => {
    expect(fbpWindowOpen(null, "2026-04-01", "2026-12-01").open).toBe(true);
    const w = { opens: "04-01", closes: "04-30" };
    expect(fbpWindowOpen(w, "2026-04-01", "2026-04-15")).toEqual({ open: true, message: "Flexible benefits can be changed until 30 Apr 2026." });
    expect(fbpWindowOpen(w, "2026-04-01", "2026-06-01").open).toBe(false);
    expect(fbpWindowOpen({ opens: "01-01", closes: "01-31" }, "2026-04-01", "2026-12-01").message).toBe("Flexible benefits open on 1 Jan 2027.");
    expect(fbpWindowOpen({ opens: "01-01", closes: "01-31" }, "2026-04-01", "2027-01-20").open).toBe(true);
  });
});
