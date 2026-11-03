import { describe, expect, it } from "vitest";
import { dueTrialReminder, featureAllowed, featureProblem, planFor, quote, trialDaysLeft } from "./plans";

describe("plans", () => {
  it("gates features by tier and names the cheapest plan that has them", () => {
    expect(featureAllowed("core", "sso")).toBe(false);
    expect(featureAllowed("plus", "sso")).toBe(true);
    expect(featureAllowed("plus", "api")).toBe(false);
    expect(featureAllowed("pro", "api")).toBe(true);
    expect(featureAllowed(undefined, "api")).toBe(true);   // unknown plan (scripts) = no gate
    expect(planFor("api")).toBe("pro");
    expect(planFor("sso")).toBe("plus");
    expect(featureProblem({ plan: "core" }, "sso")).toMatch(/Plus plan/);
    expect(featureProblem({}, "sso")).toBeNull();
    expect(featureProblem({ plan: "pro", status: "suspended" }, "sso")).toMatch(/not active/);
    expect(featureProblem({ plan: "pro", status: "active" }, "sso")).toBeNull();
  });
  it("quotes seats at the plan minimum, adds GST and discounts yearly", () => {
    const q = quote("core", 10, "quarterly");
    expect(q.billedSeats).toBe(25);
    expect(q.basePaise).toBe(6_000 * 25 * 3);
    expect(q.gstPaise).toBe(Math.round(q.amountPaise * 0.18));
    expect(q.totalPaise).toBe(q.amountPaise + q.gstPaise);
    const y = quote("plus", 40, "yearly");
    expect(y.discountPaise).toBe(Math.round(9_900 * 40 * 12 * 0.1));
  });
  it("counts trial days and picks the reminder that is due once", () => {
    const now = new Date("2026-11-03T06:00:00Z");
    expect(trialDaysLeft("2026-11-10T06:00:00Z", now)).toBe(7);
    expect(trialDaysLeft(null, now)).toBeNull();
    expect(dueTrialReminder(7, [])).toBe("7d");
    expect(dueTrialReminder(7, ["7d"])).toBeNull();
    expect(dueTrialReminder(1, ["7d"])).toBe("1d");
    expect(dueTrialReminder(-2, ["7d", "1d"])).toBe("ended");
    expect(dueTrialReminder(12, [])).toBeNull();
  });
});
