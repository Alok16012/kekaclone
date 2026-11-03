import { describe, expect, it } from "vitest";
import {
  DEFAULT_OVERTIME_RULES, compOffDaysFor, compOffDelta, creditableMinutes, normalizeRules, overtimeMinutes, overtimePaise, roundMinutes, validateOvertimeRequest, validateOvertimeRules, validatePayCode, wageOnBasis,
  type OvertimeRules,
} from "./overtime-rules";

const ist = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`);
const rules: OvertimeRules = {
  ...DEFAULT_OVERTIME_RULES,
  working: { ...DEFAULT_OVERTIME_RULES.working, enabled: true, mode: "pay", pay_code_id: "pc", coverage: { pre: false, post: true }, min_minutes: 30, max_minutes: 240, rounding: { to: 15, mode: "down" } },
  weekly_off: { ...DEFAULT_OVERTIME_RULES.weekly_off, enabled: true, mode: "comp_off", min_minutes: 240, max_minutes: null },
};
const day = (over: Partial<Parameters<typeof overtimeMinutes>[1]>) => ({
  dayType: "working" as const, shiftKind: "fixed" as const, shiftStart: ist("2026-11-02", "09:30"), shiftEnd: ist("2026-11-02", "18:30"),
  firstIn: ist("2026-11-02", "09:20"), lastOut: ist("2026-11-02", "20:40"), gross: 680, effective: 680, required: 480, final: true, ...over,
});

describe("overtime minutes", () => {
  it("counts time after a fixed shift, rounded down to 15 and capped", () => {
    expect(overtimeMinutes(rules, day({}))).toBe(120);                                            // 18:30 → 20:40 = 130 → 120
    expect(overtimeMinutes(rules, day({ lastOut: ist("2026-11-02", "18:50"), gross: 570, effective: 570 }))).toBe(0);   // 20 min < threshold 30
    expect(overtimeMinutes(rules, day({ lastOut: ist("2026-11-03", "01:00"), gross: 940, effective: 940 }))).toBe(240); // capped
  });
  it("ignores time before the shift unless pre coverage is on", () => {
    const early = day({ firstIn: ist("2026-11-02", "07:00"), lastOut: ist("2026-11-02", "18:30"), gross: 690, effective: 690 });
    expect(overtimeMinutes(rules, early)).toBe(0);
    const pre = { ...rules, working: { ...rules.working, coverage: { pre: true, post: true } } };
    expect(overtimeMinutes(pre, early)).toBe(150);
  });
  it("never exceeds what was worked beyond the shift's requirement (long breaks aren't overtime)", () => {
    // in at 09:20, out at 20:40 but only 500 effective minutes: 500 - 480 = 20 < threshold
    expect(overtimeMinutes(rules, day({ effective: 500 }))).toBe(0);
    expect(overtimeMinutes({ ...rules, basis: "gross" }, day({ effective: 500 }))).toBe(120);
  });
  it("counts everything worked on weekly offs and holidays, and flexible shifts beyond required hours", () => {
    expect(overtimeMinutes(rules, day({ dayType: "weekly_off", shiftStart: null, shiftEnd: null, required: 0, effective: 300, gross: 320 }))).toBe(300);
    expect(overtimeMinutes(rules, day({ dayType: "weekly_off", effective: 200, required: 0 }))).toBe(0);                 // below the off-day threshold
    expect(overtimeMinutes(rules, day({ shiftKind: "flexible", effective: 560, gross: 600 }))).toBe(75);               // 560 - 480 = 80 → 75
    expect(overtimeMinutes({ ...rules, holiday: { ...rules.holiday, enabled: false } }, day({ dayType: "holiday", effective: 300 }))).toBe(0);   // holidays switched off
  });
  it("is zero while the day is open, without a policy, or when the day type is disabled", () => {
    expect(overtimeMinutes(rules, day({ final: false }))).toBe(0);
    expect(overtimeMinutes(null, day({}))).toBe(0);
    expect(overtimeMinutes({ ...rules, working: { ...rules.working, enabled: false } }, day({}))).toBe(0);
  });
  it("rounds to the nearest or down", () => {
    expect(roundMinutes(130, { to: 15, mode: "down" })).toBe(120);
    expect(roundMinutes(130, { to: 15, mode: "nearest" })).toBe(135);
    expect(roundMinutes(130, { to: 60, mode: "nearest" })).toBe(120);
    expect(roundMinutes(130, { to: 1, mode: "down" })).toBe(130);
  });
  it("credits only approved minutes when approval is required, never more than computed", () => {
    expect(creditableMinutes(rules, 120, null)).toBe(0);
    expect(creditableMinutes(rules, 120, 90)).toBe(90);
    expect(creditableMinutes(rules, 120, 300)).toBe(120);
    expect(creditableMinutes({ ...rules, approval: "none" }, 120, null)).toBe(120);
    expect(creditableMinutes(rules, 0, 90)).toBe(0);
  });
});

describe("overtime pay and comp-off", () => {
  it("multiplier × hourly, with tiers beyond a point", () => {
    expect(overtimePaise(120, 10000, { kind: "multiplier", value: 2 }, [])).toBe(40000);
    expect(overtimePaise(180, 10000, { kind: "multiplier", value: 1.5 }, [{ after_minutes: 120, multiplier: 2 }])).toBe(30000 + 20000);
    expect(overtimePaise(60, 10000, { kind: "multiplier", value: 1.5 }, [{ after_minutes: 120, multiplier: 2 }])).toBe(15000);
  });
  it("fixed per hour and lump sum", () => {
    expect(overtimePaise(90, 10000, { kind: "fixed_per_hour", value: 150 }, [])).toBe(22500);
    expect(overtimePaise(30, 10000, { kind: "lump_sum", value: 500 }, [])).toBe(50000);
    expect(overtimePaise(0, 10000, { kind: "lump_sum", value: 500 }, [])).toBe(0);
  });
  it("wage basis: basic or the sum of earning components", () => {
    const breakup = { BASIC: 3000000, HRA: 1500000, SPECIAL: 500000, PF_EMPLOYER: 360000 };
    expect(wageOnBasis(breakup, "basic", new Set(["BASIC", "HRA", "SPECIAL"]))).toBe(3000000);
    expect(wageOnBasis(breakup, "gross", new Set(["BASIC", "HRA", "SPECIAL"]))).toBe(5000000);
  });
  it("comp-off days per day and idempotent monthly deltas", () => {
    const c = { full_day_minutes: 480, half_day_minutes: 240 };
    expect(compOffDaysFor(500, c)).toBe(1);
    expect(compOffDaysFor(300, c)).toBe(0.5);
    expect(compOffDaysFor(100, c)).toBe(0);
    expect(compOffDelta("e", "2026-10-01", 0, 1.5)).toEqual({ amount: 1.5, key: "ot:e:2026-10-01:0>150" });
    expect(compOffDelta("e", "2026-10-01", 1.5, 1.5)).toBeNull();
    expect(compOffDelta("e", "2026-10-01", 1.5, 1, 2)).toEqual({ amount: -0.5, key: "ot:e:2026-10-01:150>100#2" });
  });
});

describe("validation", () => {
  it("fills defaults for stored policies missing newer keys", () => {
    const r = normalizeRules({ basis: "gross", working: { enabled: true, mode: "pay" } as never });
    expect(r.basis).toBe("gross");
    expect(r.working.rounding).toEqual({ to: 15, mode: "down" });
    expect(r.holiday.mode).toBe("comp_off");
    expect(r.hours_per_month).toBe(208);
  });
  it("rejects bad policies with a readable message", () => {
    expect(validateOvertimeRules(rules)).toBeNull();
    expect(validateOvertimeRules({ ...rules, working: { ...rules.working, pay_code_id: null } })).toMatch(/pay code/);
    expect(validateOvertimeRules({ ...rules, working: { ...rules.working, coverage: { pre: false, post: false } } })).toMatch(/before the shift/);
    expect(validateOvertimeRules({ ...rules, working: { ...rules.working, tiers: [{ after_minutes: 120, multiplier: 2 }, { after_minutes: 60, multiplier: 3 }] } })).toMatch(/Tiers/);
    expect(validateOvertimeRules({ ...rules, comp_off: { full_day_minutes: 200, half_day_minutes: 240 } })).toMatch(/half-day/);
    expect(validateOvertimeRules({ ...rules, hours_per_month: 10 })).toMatch(/Hours per month/);
  });
  it("pay codes and requests", () => {
    expect(validatePayCode({ name: "Double", kind: "multiplier", value: 2 })).toBeNull();
    expect(validatePayCode({ name: "Double", kind: "multiplier", value: 9 })).toMatch(/at most 5/);
    expect(validatePayCode({ name: "", kind: "lump_sum", value: 1 })).toMatch(/name/);
    const base = { date: "2026-11-02", today: "2026-11-03", joining: "2025-01-01", minutes: 120, reason: "Release night", pastDays: 7, pendingSameDay: false, computed: 130 };
    expect(validateOvertimeRequest(base)).toBeNull();
    expect(validateOvertimeRequest({ ...base, date: "2026-11-04" })).toMatch(/today or earlier/);
    expect(validateOvertimeRequest({ ...base, date: "2026-10-20" })).toMatch(/7 days back/);
    expect(validateOvertimeRequest({ ...base, minutes: 5 })).toMatch(/15 minutes/);
    expect(validateOvertimeRequest({ ...base, pendingSameDay: true })).toMatch(/already/);
    expect(validateOvertimeRequest({ ...base, reason: " " })).toMatch(/note/);
  });
});
