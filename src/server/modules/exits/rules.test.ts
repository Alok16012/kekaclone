import { describe, expect, it } from "vitest";
import { canCompleteNow, dueForRelieving, lastWorkingDay, nextStatus, noticeDays, resolveOwner, stageOf, validateExitDates, waivedDays } from "./rules";

describe("notice period", () => {
  it("uses the regular notice outside probation", () => expect(noticeDays({ days: 60, probation_days: 15 }, false)).toBe(60));
  it("uses the probation notice while on probation", () => expect(noticeDays({ days: 60, probation_days: 15 }, true)).toBe(15));
  it("falls back to the regular notice when the policy has no probation figure", () => expect(noticeDays({ days: 30, probation_days: null }, true)).toBe(30));
  it("no policy means no notice", () => expect(noticeDays(null, false)).toBe(0));
});

describe("last working day", () => {
  it("adds the notice days, across months and leap years", () => {
    expect(lastWorkingDay("2026-11-01", 30)).toBe("2026-12-01");
    expect(lastWorkingDay("2028-02-01", 30)).toBe("2028-03-02");
    expect(lastWorkingDay("2026-12-15", 90)).toBe("2027-03-15");
  });
  it("zero notice is the same day; negatives clamp to zero", () => {
    expect(lastWorkingDay("2026-11-01", 0)).toBe("2026-11-01");
    expect(lastWorkingDay("2026-11-01", -5)).toBe("2026-11-01");
  });
  it("counts waived days when the agreed day is earlier", () => {
    expect(waivedDays("2026-12-01", "2026-11-21")).toBe(10);
    expect(waivedDays("2026-12-01", "2026-12-05")).toBe(0);
  });
});

describe("exit dates", () => {
  const today = "2026-10-30";
  it("employees resign today with a future last day", () => {
    expect(validateExitDates({ resignationDate: today, lastWorkingDate: "2026-11-29", today, by: "self" })).toEqual([]);
    expect(validateExitDates({ resignationDate: "2026-10-01", lastWorkingDate: "2026-11-29", today, by: "self" }).map((e) => e.field)).toContain("resignationDate");
  });
  it("the last day can't be before the resignation", () => {
    expect(validateExitDates({ resignationDate: today, lastWorkingDate: "2026-10-29", today, by: "hr" })[0].field).toBe("lastWorkingDate");
  });
  it("HR may backdate within a year, but not far into the future", () => {
    expect(validateExitDates({ resignationDate: "2026-01-10", lastWorkingDate: "2026-02-10", today, by: "hr" })).toEqual([]);
    expect(validateExitDates({ resignationDate: "2025-01-10", lastWorkingDate: "2025-02-10", today, by: "hr" })).toHaveLength(1);
    expect(validateExitDates({ resignationDate: "2027-03-01", lastWorkingDate: "2027-04-01", today, by: "hr" })).toHaveLength(1);
  });
  it("rejects malformed dates", () => expect(validateExitDates({ resignationDate: "30-10-2026", lastWorkingDate: "2026-11-01", today, by: "hr" })).toHaveLength(1));
});

describe("exit state machine", () => {
  it("allows the expected moves only", () => {
    expect(nextStatus("under_review", "approve")).toBe("in_progress");
    expect(nextStatus("under_review", "withdraw")).toBe("withdrawn");
    expect(nextStatus("under_review", "reject")).toBe("rejected");
    expect(nextStatus("in_progress", "complete")).toBe("exited");
    expect(nextStatus("in_progress", "withdraw")).toBeNull();
    expect(nextStatus("under_review", "complete")).toBeNull();
    expect(nextStatus("exited", "cancel")).toBeNull();
    expect(nextStatus("withdrawn", "approve")).toBeNull();
  });
  it("maps statuses to board tabs", () => {
    expect(stageOf("under_review")).toBe("review");
    expect(stageOf("in_progress")).toBe("progress");
    expect(stageOf("exited")).toBe("exited");
    expect(stageOf("withdrawn")).toBeNull();
  });
  it("relieves the day after the last working day; HR can finish from the day itself", () => {
    expect(dueForRelieving("2026-10-30", "2026-10-30")).toBe(false);
    expect(dueForRelieving("2026-10-29", "2026-10-30")).toBe(true);
    expect(canCompleteNow("2026-10-30", "2026-10-30")).toBe(true);
    expect(canCompleteNow("2026-10-31", "2026-10-30")).toBe(false);
  });
});

describe("checklist owners", () => {
  const roles: Record<string, string> = { hr_admin: "hr", global_admin: "admin" };
  const ctx = { employeeId: "emp", managerId: "mgr", roleHolder: (r: string) => roles[r] ?? null };
  it("resolves self, manager and role owners", () => {
    expect(resolveOwner({ type: "self" }, ctx)).toBe("emp");
    expect(resolveOwner({ type: "manager" }, ctx)).toBe("mgr");
    expect(resolveOwner({ type: "role", role: "hr_admin" }, ctx)).toBe("hr");
  });
  it("falls back to HR when there's no manager, and to an admin when nobody holds the role", () => {
    expect(resolveOwner({ type: "manager" }, { ...ctx, managerId: null })).toBe("hr");
    expect(resolveOwner({ type: "role", role: "it_admin" }, ctx)).toBe("admin");
  });
});
