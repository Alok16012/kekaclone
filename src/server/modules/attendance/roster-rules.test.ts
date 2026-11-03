import { describe, expect, it } from "vitest";
import { autoAssignedShift, expandRotation, validateRotation, validateShiftChange, validateShiftRule, validateWeeklyOffChange, weekDays, weekStartOf } from "./roster-rules";

describe("weeks and rotations", () => {
  it("weeks start on Monday", () => {
    expect(weekStartOf("2026-11-03")).toBe("2026-11-02");   // Tuesday → Monday
    expect(weekStartOf("2026-11-01")).toBe("2026-10-26");   // Sunday → previous Monday
    expect(weekDays("2026-11-02")).toHaveLength(7);
    expect(weekDays("2026-11-02")[6]).toBe("2026-11-08");
  });
  it("weekly pattern maps by weekday and skips null cells", () => {
    const out = expandRotation({ kind: "weekly", week: ["A", "A", "A", "A", "A", "off", null] }, "e1", "2026-11-04", 7);   // Wed..Tue
    expect(out.map((e) => `${e.date}:${e.value}`)).toEqual([
      "2026-11-04:A", "2026-11-05:A", "2026-11-06:A", "2026-11-07:off", "2026-11-09:A", "2026-11-10:A",
    ]);
  });
  it("a cycle repeats from the start date", () => {
    const out = expandRotation({ kind: "cycle", sequence: ["D", "D", "N", "N", "off"] }, "e1", "2026-11-02", 12);
    expect(out.map((e) => e.value)).toEqual(["D", "D", "N", "N", "off", "D", "D", "N", "N", "off", "D", "D"]);
    expect(out[5].date).toBe("2026-11-07");
  });
  it("validates rotations", () => {
    expect(validateRotation({ kind: "weekly", week: ["A", null, null, null, null, null, null] }, 28)).toBeNull();
    expect(validateRotation({ kind: "weekly", week: ["A", "A"] }, 28)).toMatch(/seven/);
    expect(validateRotation({ kind: "cycle", sequence: ["A"] }, 28)).toMatch(/between 2 and 60/);
    expect(validateRotation({ kind: "cycle", sequence: [null, null] }, 28)).toMatch(/at least one/);
    expect(validateRotation({ kind: "cycle", sequence: ["A", "off"] }, 0)).toMatch(/between 1 and 366/);
  });
});

describe("shift change and weekly-off swap rules", () => {
  const rule = { allowed_shift_ids: ["NIGHT"], request_window_days: 30, max_requests_per_month: 2, allow_on_off_days: false };
  const base = { from: "2026-11-10", to: "2026-11-12", today: "2026-11-03", joining: "2025-01-01", shiftId: "NIGHT", currentShiftId: "GEN", reason: "Covering the night desk", rule, usedThisMonth: 0, overlaps: false, offDaysInRange: 0 };
  it("accepts a request inside the rule", () => { expect(validateShiftChange(base)).toBeNull(); });
  it("rejects the wrong shift, the past, too far ahead, too many, off days and overlaps", () => {
    expect(validateShiftChange({ ...base, shiftId: "FLEX" })).toMatch(/can't be requested/);
    expect(validateShiftChange({ ...base, shiftId: "GEN" })).toMatch(/already your shift/);
    expect(validateShiftChange({ ...base, from: "2026-11-01", to: "2026-11-01" })).toMatch(/today or later/);
    expect(validateShiftChange({ ...base, from: "2026-12-20", to: "2026-12-21" })).toMatch(/30 days ahead/);
    expect(validateShiftChange({ ...base, usedThisMonth: 2 })).toMatch(/all 2/);
    expect(validateShiftChange({ ...base, offDaysInRange: 1 })).toMatch(/weekly off or holiday/);
    expect(validateShiftChange({ ...base, overlaps: true })).toMatch(/already have/);
    expect(validateShiftChange({ ...base, to: "2026-11-09" })).toMatch(/before the start/);
    expect(validateShiftChange({ ...base, reason: "" })).toMatch(/reason/);
  });
  it("without a rule any shift is fine up to 60 days ahead", () => {
    expect(validateShiftChange({ ...base, rule: null, shiftId: "FLEX" })).toBeNull();
    expect(validateShiftChange({ ...base, rule: null, from: "2027-02-01", to: "2027-02-01" })).toMatch(/60 days/);
  });
  it("weekly-off swap: a working day for one of your offs, same month", () => {
    const swap = { offDate: "2026-11-11", workDate: "2026-11-14", today: "2026-11-03", joining: "2025-01-01", reason: "Family function", offDateType: "working", workDateType: "weekly_off", rule, usedThisMonth: 0, overlaps: false };
    expect(validateWeeklyOffChange(swap)).toBeNull();
    expect(validateWeeklyOffChange({ ...swap, workDateType: "working" })).toMatch(/weekly offs/);
    expect(validateWeeklyOffChange({ ...swap, offDateType: "weekly_off" })).toMatch(/working day/);
    expect(validateWeeklyOffChange({ ...swap, workDate: "2026-12-05" })).toMatch(/same month/);
    expect(validateWeeklyOffChange({ ...swap, offDate: "2026-11-14" })).toMatch(/two different/);
    expect(validateWeeklyOffChange({ ...swap, usedThisMonth: 2 })).toMatch(/all 2/);
  });
  it("validates rules themselves", () => {
    expect(validateShiftRule({ name: "Standard", request_window_days: 30, max_requests_per_month: 2 })).toBeNull();
    expect(validateShiftRule({ name: "", request_window_days: null, max_requests_per_month: null })).toMatch(/name/);
    expect(validateShiftRule({ name: "x", request_window_days: 400, max_requests_per_month: null })).toMatch(/365/);
    expect(validateShiftRule({ name: "x", request_window_days: null, max_requests_per_month: 40 })).toMatch(/31/);
  });
});

describe("auto shift assignment", () => {
  const shifts = [
    { id: "GEN", auto_assign: { from: "07:00", to: "12:00" } },
    { id: "NIGHT", auto_assign: { from: "19:00", to: "02:00" } },
    { id: "FLEX", auto_assign: null },
  ];
  it("picks the shift whose window holds the first clock-in, including windows past midnight", () => {
    expect(autoAssignedShift(9 * 60 + 15, shifts)?.id).toBe("GEN");
    expect(autoAssignedShift(21 * 60, shifts)?.id).toBe("NIGHT");
    expect(autoAssignedShift(1 * 60, shifts)?.id).toBe("NIGHT");
    expect(autoAssignedShift(14 * 60, shifts)).toBeNull();
  });
});
