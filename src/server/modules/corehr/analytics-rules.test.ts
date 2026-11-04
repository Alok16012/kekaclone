import { describe, expect, it } from "vitest";
import { addMonths, annualisedAttrition, averageTenure, byDepartment, byReason, monthlySeries, monthsBetween, tenureBands, type EmploymentRecord } from "./analytics-rules";

const P = (id: string, joining_date: string, exit_date: string | null = null, department: string | null = "Eng", reason: string | null = null, kind: EmploymentRecord["kind"] = null): EmploymentRecord => ({ id, joining_date, exit_date, department, reason, kind });

describe("people analytics", () => {
  it("month arithmetic", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthsBetween("2026-10", "2026-12")).toEqual(["2026-10", "2026-11", "2026-12"]);
  });
  it("monthly headcount, joiners, leavers and the rate against the start headcount", () => {
    const people = [P("a", "2025-01-01"), P("b", "2025-06-15", "2026-10-20", "Eng", "Better opportunity", "resignation"), P("c", "2026-10-05"), P("d", "2026-11-03")];
    const rows = monthlySeries(people, "2026-10", "2026-11");
    expect(rows[0]).toMatchObject({ month: "2026-10", start: 2, joined: 1, left: 1, end: 2, rate: 50 });
    expect(rows[1]).toMatchObject({ month: "2026-11", start: 2, joined: 1, left: 0, end: 3, rate: 0 });
    expect(monthlySeries([], "2026-10", "2026-10")[0].rate).toBeNull();
    expect(annualisedAttrition(rows)).toBeCloseTo(1 / ((2 + 2) / 2 + (2 + 3) / 2) * 2 * 6 * 100, 0);
    expect(annualisedAttrition([])).toBeNull();
  });
  it("groups attrition by department and reason", () => {
    const people = [P("a", "2025-01-01", "2026-10-10", "Eng", "Compensation", "resignation"), P("b", "2025-01-01", null, "Eng"), P("c", "2025-01-01", "2026-11-01", null, null, "company_action"), P("d", "2027-01-01")];
    const d = byDepartment(people, "2026-10", "2026-11");
    expect(d.find((x) => x.name === "Eng")).toEqual({ name: "Eng", headcount: 2, left: 1, rate: 50 });
    expect(d.find((x) => x.name === "No department")).toEqual({ name: "No department", headcount: 1, left: 1, rate: 100 });
    expect(byReason(people, "2026-10", "2026-11")).toEqual([{ reason: "Compensation", kind: "Resignation", n: 1 }, { reason: "Not recorded", kind: "Company action", n: 1 }]);
    expect(byReason(people, "2026-01", "2026-09")).toEqual([]);
  });
  it("average tenure and bands", () => {
    const people = [P("a", "2024-11-03"), P("b", "2026-05-03"), P("c", "2020-01-01", "2026-10-31")];
    const t = averageTenure(people, "2026-11-03", "2026-10", "2026-11");
    expect(t.currentCount).toBe(2); expect(t.current).toBeCloseTo(1.3, 1);
    expect(t.leaverCount).toBe(1); expect(t.leavers).toBeCloseTo(6.8, 1);
    expect(tenureBands(people, "2026-11-03")).toEqual([{ label: "< 1 year", n: 1 }, { label: "1–3 years", n: 1 }, { label: "3–5 years", n: 0 }, { label: "5+ years", n: 0 }]);
  });
});
