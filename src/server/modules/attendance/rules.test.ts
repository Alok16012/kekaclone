import { describe, expect, it } from "vitest";
import {
  allocateDeductions, attendanceDateOf, checkPunch, dayWindow, evaluateDay, fenceFor, haversineMeters, ipAllowed, ipInCidr, isValidCidr,
  leavePortion, ledgerDelta, localDate, penaltiesFor, timingMinutes, validatePartial, validatePenaltyPolicy, validateRegularization,
  validateRemote, validateShift, zonedToUtc, type CapturePolicy, type DayInputs, type PenaltyPolicy, type ShiftDef,
} from "./rules";

const IST = "Asia/Kolkata";
const at = (iso: string) => new Date(iso);
const general: ShiftDef = {
  kind: "fixed", break_minutes: 60, grace_minutes: 15, half_day_minutes: 240,
  timings: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { start: "09:30", end: "18:30" }])),
};
const night: ShiftDef = {
  kind: "fixed", break_minutes: 30, grace_minutes: 10, half_day_minutes: 240,
  timings: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { start: "22:00", end: "06:00" }])),
};
// 2026-10-26 is a Monday
const base = (over: Partial<DayInputs> = {}): DayInputs => ({
  date: "2026-10-26", tz: IST, dayType: "working", joined: true, shift: general, punches: [], final: true,
  leavePortion: 0, remote: null, partial: { lateMinutes: 0, earlyMinutes: 0 }, ...over,
});

describe("time zones", () => {
  it("converts local wall-clock time to UTC", () => {
    expect(zonedToUtc("2026-10-26", 9 * 60 + 30, IST).toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(zonedToUtc("2026-10-26", -60, IST).toISOString()).toBe("2026-10-25T17:30:00.000Z");
    expect(zonedToUtc("2026-10-26", 24 * 60 + 360, IST).toISOString()).toBe("2026-10-27T00:30:00.000Z");
  });
  it("handles a zone with daylight saving (New York, clocks go back 1 Nov 2026)", () => {
    expect(zonedToUtc("2026-10-30", 9 * 60, "America/New_York").toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(zonedToUtc("2026-11-02", 9 * 60, "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
  it("reads the local date of an instant", () => {
    expect(localDate(at("2026-10-26T19:00:00Z"), IST)).toBe("2026-10-27");
    expect(localDate(at("2026-10-26T18:00:00Z"), IST)).toBe("2026-10-26");
  });
});

describe("shifts and day windows", () => {
  it("measures overnight timings", () => {
    expect(timingMinutes({ start: "22:00", end: "06:00" })).toBe(480);
    expect(timingMinutes({ start: "09:30", end: "18:30" })).toBe(540);
  });
  it("validates shifts", () => {
    const ok = { name: "Night", code: "NIGHT", kind: "fixed", timings: { mon: { start: "22:00", end: "06:00" } }, break_minutes: 30, grace_minutes: 10, half_day_minutes: 240 };
    expect(validateShift(ok)).toBeNull();
    expect(validateShift({ ...ok, timings: {} })).toMatch(/at least one day/);
    expect(validateShift({ ...ok, timings: { mon: { start: "9:30", end: "18:00" } } })).toMatch(/09:30/);
    expect(validateShift({ ...ok, timings: { mon: { start: "08:00", end: "08:00" } } })).toMatch(/same time/);
    expect(validateShift({ ...ok, break_minutes: 600 })).toMatch(/break/);
    expect(validateShift({ ...ok, code: "has space" })).toMatch(/code/);
  });
  it("a day shift's window opens 4 hours before the start", () => {
    const w = dayWindow("2026-10-26", general, general, IST);
    expect(w.start.toISOString()).toBe("2026-10-26T00:00:00.000Z");   // 05:30 IST
    expect(w.end.toISOString()).toBe("2026-10-27T00:00:00.000Z");
  });
  it("a night shift's punches after midnight belong to the start date", () => {
    const shiftOn = () => night;
    expect(attendanceDateOf(at("2026-10-26T16:35:00Z"), IST, shiftOn)).toBe("2026-10-26");   // 22:05 Mon
    expect(attendanceDateOf(at("2026-10-27T00:40:00Z"), IST, shiftOn)).toBe("2026-10-26");   // 06:10 Tue
    expect(attendanceDateOf(at("2026-10-27T13:00:00Z"), IST, shiftOn)).toBe("2026-10-27");   // 18:30 Tue
  });
  it("with no shift, a day is local midnight to midnight", () => {
    expect(attendanceDateOf(at("2026-10-26T18:29:00Z"), IST, () => null)).toBe("2026-10-26");
    expect(attendanceDateOf(at("2026-10-26T18:31:00Z"), IST, () => null)).toBe("2026-10-27");
  });
});

describe("evaluateDay", () => {
  it("present, on time: gross, effective, no late", () => {
    const r = evaluateDay(base({ punches: [at("2026-10-26T04:05:00Z"), at("2026-10-26T13:10:00Z")] }));   // 09:35–18:40
    expect(r).toMatchObject({ status: "present", gross: 545, effective: 545, late: 0, lateRaw: 5, early: 0, missingSwipe: false });
  });
  it("effective time counts in→out pairs only", () => {
    const r = evaluateDay(base({ punches: [at("2026-10-26T04:00:00Z"), at("2026-10-26T07:00:00Z"), at("2026-10-26T08:00:00Z"), at("2026-10-26T13:00:00Z")] }));
    expect(r.gross).toBe(540); expect(r.effective).toBe(480);
  });
  it("late beyond grace, early leave and a partial-day allowance", () => {
    const p = [at("2026-10-26T04:50:00Z"), at("2026-10-26T12:00:00Z")];   // 10:20 – 17:30
    expect(evaluateDay(base({ punches: p }))).toMatchObject({ late: 50, early: 60 });
    expect(evaluateDay(base({ punches: p, partial: { lateMinutes: 40, earlyMinutes: 60 } }))).toMatchObject({ late: 0, lateRaw: 10, early: 0 });
  });
  it("night shift: late and early are measured against the overnight timing", () => {
    const r = evaluateDay(base({ shift: night, punches: [at("2026-10-26T16:55:00Z"), at("2026-10-27T00:00:00Z")] }));   // 22:25 → 05:30
    expect(r).toMatchObject({ status: "present", late: 25, early: 30, effective: 425 });
  });
  it("a single punch on a finished day is a missing swipe", () => {
    expect(evaluateDay(base({ punches: [at("2026-10-26T04:00:00Z")] })).missingSwipe).toBe(true);
    expect(evaluateDay(base({ punches: [at("2026-10-26T04:00:00Z")], final: false })).missingSwipe).toBe(false);
  });
  it("statuses: absent, leave, half leave, WFH, weekly off, holiday, not joined", () => {
    expect(evaluateDay(base()).status).toBe("absent");
    expect(evaluateDay(base({ leavePortion: 1 })).status).toBe("leave");
    expect(evaluateDay(base({ leavePortion: 0.5 })).status).toBe("half_leave");
    expect(evaluateDay(base({ remote: { kind: "wfh", portion: 1 } })).status).toBe("wfh");
    expect(evaluateDay(base({ remote: { kind: "on_duty", portion: 0.5 } })).status).toBe("half_day");
    expect(evaluateDay(base({ remote: { kind: "on_duty", portion: 0.5 }, punches: [at("2026-10-26T04:00:00Z"), at("2026-10-26T08:00:00Z")] })).status).toBe("on_duty");
    expect(evaluateDay(base({ dayType: "weekly_off" })).status).toBe("weekly_off");
    expect(evaluateDay(base({ dayType: "holiday" })).status).toBe("holiday");
    expect(evaluateDay(base({ dayType: "holiday", punches: [at("2026-10-26T04:00:00Z"), at("2026-10-26T08:00:00Z")] })).status).toBe("present");
    expect(evaluateDay(base({ joined: false })).status).toBe("not_joined");
  });
  it("a half weekly off needs half a day", () => {
    const r = evaluateDay(base({ dayType: "half_weekly_off", leavePortion: 0.5 }));
    expect(r).toMatchObject({ required: 0.5, covered: 0.5, status: "leave" });
  });
  it("flexible shifts are never late", () => {
    const flex: ShiftDef = { ...general, kind: "flexible" };
    expect(evaluateDay(base({ shift: flex, punches: [at("2026-10-26T06:00:00Z"), at("2026-10-26T14:00:00Z")] })).late).toBe(0);
  });
});

describe("penalties", () => {
  const policy: PenaltyPolicy = {
    late_arrival: { enabled: true, grace_minutes: null, free_per_month: 2, deduct_days: 0.5 },
    hours_shortage: { enabled: true, basis: "effective", full_day_minutes: 480, half_day_minutes: 240 },
    no_attendance: { enabled: true },
    missing_swipe: { enabled: true, deduct_days: 0.5 },
  };
  const run = (over: Partial<DayInputs>, prior = 0, p: PenaltyPolicy | null = policy) => { const i = base(over); return penaltiesFor(p, evaluateDay(i), i, prior); };
  const late = [at("2026-10-26T04:30:00Z"), at("2026-10-26T13:30:00Z")];   // 10:00 – 19:00, 9h

  it("late arrivals: the first N in a month are free, then each one costs", () => {
    expect(run({ punches: late }, 0)).toEqual([expect.objectContaining({ rule: "late_arrival", incident: 1, days: 0 })]);
    expect(run({ punches: late }, 1)[0]).toMatchObject({ incident: 2, days: 0 });
    expect(run({ punches: late }, 2)[0]).toMatchObject({ incident: 3, days: 0.5 });
  });
  it("within grace is not late; the policy can override the shift's grace", () => {
    const p = [at("2026-10-26T04:10:00Z"), at("2026-10-26T13:30:00Z")];   // 09:40, 10 min late
    expect(run({ punches: p }, 5)).toEqual([]);
    expect(run({ punches: p }, 5, { ...policy, late_arrival: { ...policy.late_arrival!, grace_minutes: 5 } })[0]).toMatchObject({ rule: "late_arrival", days: 0.5 });
  });
  it("no attendance on a working day goes to loss of pay, half when half covered", () => {
    expect(run({})).toEqual([expect.objectContaining({ rule: "no_attendance", days: 1, lopOnly: true })]);
    expect(run({ leavePortion: 0.5 })).toEqual([expect.objectContaining({ rule: "no_attendance", days: 0.5 })]);
    expect(run({ leavePortion: 1 })).toEqual([]);
    expect(run({ remote: { kind: "wfh", portion: 1 } })).toEqual([]);
    expect(run({ dayType: "weekly_off" })).toEqual([]);
    expect(run({ dayType: "holiday" })).toEqual([]);
  });
  it("nothing is judged before the day is over or before joining", () => {
    expect(run({ final: false })).toEqual([]);
    expect(run({ joined: false })).toEqual([]);
    expect(run({}, 0, null)).toEqual([]);
  });
  it("hours shortage: under the half-day minimum costs a day, under full costs half", () => {
    expect(run({ punches: [at("2026-10-26T04:00:00Z"), at("2026-10-26T07:00:00Z")] })).toEqual([expect.objectContaining({ rule: "hours_shortage", days: 1 })]);
    expect(run({ punches: [at("2026-10-26T04:00:00Z"), at("2026-10-26T11:00:00Z")] })).toEqual([expect.objectContaining({ rule: "hours_shortage", days: 0.5 })]);
    expect(run({ punches: [at("2026-10-26T04:00:00Z"), at("2026-10-26T12:00:00Z")] })).toEqual([]);
    // approved partial-day minutes count as worked
    expect(run({ punches: [at("2026-10-26T04:00:00Z"), at("2026-10-26T11:00:00Z")], partial: { lateMinutes: 0, earlyMinutes: 60 } })).toEqual([]);
  });
  it("missing swipe is penalised instead of short hours", () => {
    expect(run({ punches: [at("2026-10-26T04:00:00Z")] })).toEqual([expect.objectContaining({ rule: "missing_swipe", days: 0.5 })]);
  });
  it("validates the policy", () => {
    expect(validatePenaltyPolicy(policy)).toBeNull();
    expect(validatePenaltyPolicy({ ...policy, hours_shortage: { enabled: true, basis: "gross", full_day_minutes: 240, half_day_minutes: 300 } })).toMatch(/less than/);
    expect(validatePenaltyPolicy({ ...policy, late_arrival: { enabled: true, free_per_month: 2, deduct_days: 0.3 } })).toMatch(/half a day/);
  });
});

describe("deductions and the ledger", () => {
  it("takes days from leave types in order, in half days, then loss of pay", () => {
    const p = [{ rule: "late_arrival" as const, days: 1, detail: "" }, { rule: "missing_swipe" as const, days: 0.5, detail: "" }];
    expect(allocateDeductions(p, [{ id: "CL", available: 0.7 }, { id: "SL", available: 0 }])).toEqual([
      { rule: "late_arrival", days: 0.5, leaveTypeId: "CL" }, { rule: "late_arrival", days: 0.5, leaveTypeId: null }, { rule: "missing_swipe", days: 0.5, leaveTypeId: null },
    ]);
    expect(allocateDeductions(p, [{ id: "CL", available: 5 }])).toEqual([{ rule: "late_arrival", days: 1, leaveTypeId: "CL" }, { rule: "missing_swipe", days: 0.5, leaveTypeId: "CL" }]);
    expect(allocateDeductions(p, [])).toEqual([{ rule: "late_arrival", days: 1, leaveTypeId: null }, { rule: "missing_swipe", days: 0.5, leaveTypeId: null }]);
    expect(allocateDeductions([{ rule: "no_attendance", days: 1, detail: "", lopOnly: true }], [{ id: "CL", available: 5 }])).toEqual([{ rule: "no_attendance", days: 1, leaveTypeId: null }]);
    expect(allocateDeductions([{ rule: "late_arrival", days: 0, detail: "" }], [{ id: "CL", available: 5 }])).toEqual([]);
  });
  it("posts only the difference, with a key that makes repeats no-ops", () => {
    expect(ledgerDelta("e", "2026-10-26", "CL", 0, 0)).toBeNull();
    expect(ledgerDelta("e", "2026-10-26", "CL", 0.5, 0.5)).toBeNull();
    expect(ledgerDelta("e", "2026-10-26", "CL", 0, 0.5)).toEqual({ amount: -0.5, key: "penalty:e:2026-10-26:CL:0>50" });
    expect(ledgerDelta("e", "2026-10-26", "CL", 0.5, 0)).toEqual({ amount: 0.5, key: "penalty:e:2026-10-26:CL:50>0" });
    // reversed and re-applied: every posting gets its own key, so the third one isn't swallowed by the first's
    const keys = [ledgerDelta("e", "2026-10-26", "CL", 0, 0.5, 0), ledgerDelta("e", "2026-10-26", "CL", 0.5, 0, 1), ledgerDelta("e", "2026-10-26", "CL", 0, 0.5, 2)].map((d) => d!.key);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("capture rules", () => {
  it("matches IPv4 and IPv6 ranges", () => {
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(ipInCidr("::ffff:10.0.0.5", "10.0.0.0/24")).toBe(true);
    expect(ipInCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("::1", "::1/128")).toBe(true);
    expect(ipInCidr("10.0.0.1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("anything", "0.0.0.0/0")).toBe(false);
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });
  it("validates CIDR input", () => {
    for (const ok of ["10.0.0.0/8", "192.168.1.10", "2001:db8::/32", "::1"]) expect(isValidCidr(ok)).toBe(true);
    for (const bad of ["10.0.0.0/33", "300.1.1.1", "10.0.0/8", "abc", "1.2.3.4/8/1", "2001:db8::/129", "1::2::3"]) expect(isValidCidr(bad)).toBe(false);
  });
  it("an empty allowlist allows any IP; a missing IP fails a non-empty list", () => {
    expect(ipAllowed(null, [])).toBe(true);
    expect(ipAllowed(null, ["10.0.0.0/8"])).toBe(false);
  });
  it("haversine distance and geofences", () => {
    expect(Math.round(haversineMeters(12.9716, 77.5946, 12.9716, 77.5946))).toBe(0);
    const d = haversineMeters(12.9716, 77.5946, 12.9806, 77.5946);   // ~0.009° of latitude
    expect(d).toBeGreaterThan(990); expect(d).toBeLessThan(1010);
    const fences = [{ id: "a", name: "Office", lat: 12.9716, lng: 77.5946, radius_m: 200 }];
    expect(fenceFor(12.9725, 77.5946, 10, fences)?.fence.id).toBe("a");          // ~100 m
    expect(fenceFor(12.9737, 77.5946, 10, fences)).toBeNull();                    // ~233 m
    expect(fenceFor(12.9737, 77.5946, 40, fences)?.fence.id).toBe("a");          // GPS slack
    expect(fenceFor(12.9741, 77.5946, 5000, fences)).toBeNull();                  // ~280 m: slack capped at 50 m
  });
  const policy: CapturePolicy = {
    web: { enabled: true, comment_required: false, ip_ranges: ["10.0.0.0/8"] },
    mobile: { enabled: true, geofence_ids: ["a"] }, remote: { wfh: true, od: true },
    limits: { regularization_per_month: 3, regularization_past_days: 7, partial_day_minutes_per_month: 240 },
  };
  const fences = [{ id: "a", name: "Head office", lat: 12.9716, lng: 77.5946, radius_m: 200 }];
  it("accepts office network, or inside a geofence, or anywhere on a WFH day", () => {
    expect(checkPunch(policy, fences, { ip: "10.2.3.4", remoteToday: false })).toMatchObject({ ok: true, source: "web" });
    expect(checkPunch(policy, fences, { ip: "1.2.3.4", remoteToday: false })).toMatchObject({ ok: false, code: "location_needed" });
    expect(checkPunch(policy, fences, { ip: "1.2.3.4", lat: 12.9717, lng: 77.5947, remoteToday: false })).toMatchObject({ ok: true, source: "mobile", fence: "Head office" });
    expect(checkPunch(policy, fences, { ip: "1.2.3.4", lat: 13.0716, lng: 77.5946, remoteToday: false })).toMatchObject({ ok: false, code: "outside", message: expect.stringMatching(/11\.1 km from Head office/) });
    expect(checkPunch(policy, fences, { ip: "1.2.3.4", remoteToday: true })).toMatchObject({ ok: true });
  });
  it("web off / no fences / comment required", () => {
    expect(checkPunch({ ...policy, mobile: { enabled: false, geofence_ids: [] } }, [], { ip: "1.2.3.4", remoteToday: false })).toMatchObject({ code: "ip" });
    expect(checkPunch({ ...policy, web: { enabled: false, ip_ranges: [] }, mobile: { enabled: false, geofence_ids: [] } }, [], { ip: "10.0.0.1", remoteToday: false })).toMatchObject({ code: "web_off" });
    expect(checkPunch({ ...policy, web: { ...policy.web, comment_required: true } }, fences, { ip: "10.0.0.1", remoteToday: false })).toMatchObject({ code: "comment" });
    expect(checkPunch({ ...policy, web: { enabled: true, ip_ranges: [] } }, fences, { ip: null, remoteToday: false })).toMatchObject({ ok: true });
  });
});

describe("request validation", () => {
  const limits = { regularization_per_month: 3, regularization_past_days: 7, partial_day_minutes_per_month: 240 };
  const reg = { date: "2026-10-26", today: "2026-10-30", joining: "2025-01-01", inTime: "09:30", outTime: "18:30", reason: "Forgot to clock out", limits, usedThisMonth: 0, pendingSameDay: false };
  it("regularization: past days only, within the window, under the monthly limit", () => {
    expect(validateRegularization(reg)).toBeNull();
    expect(validateRegularization({ ...reg, date: "2026-10-30" })).toMatch(/past days/);
    expect(validateRegularization({ ...reg, date: "2026-10-20" })).toMatch(/7 days back/);
    expect(validateRegularization({ ...reg, usedThisMonth: 3 })).toMatch(/all 3/);
    expect(validateRegularization({ ...reg, pendingSameDay: true })).toMatch(/already/);
    expect(validateRegularization({ ...reg, joining: "2026-10-27" })).toMatch(/before you joined/);
    expect(validateRegularization({ ...reg, inTime: "9:30" })).toMatch(/09:30/);
    expect(validateRegularization({ ...reg, reason: " " })).toMatch(/reason/);
  });
  const remote = { kind: "wfh" as const, from: "2026-11-02", to: "2026-11-03", half: null, today: "2026-10-30", joining: "2025-01-01", allowed: true, pastDays: 7, overlaps: false, reason: "Plumber visit" };
  it("work from home / on duty", () => {
    expect(validateRemote(remote)).toBeNull();
    expect(validateRemote({ ...remote, allowed: false })).toMatch(/turned off/);
    expect(validateRemote({ ...remote, to: "2026-11-01" })).toMatch(/before the start/);
    expect(validateRemote({ ...remote, half: "first" })).toMatch(/single date/);
    expect(validateRemote({ ...remote, overlaps: true })).toMatch(/already/);
    expect(validateRemote({ ...remote, from: "2026-10-01", to: "2026-10-01" })).toMatch(/7 days back/);
  });
  const partial = { date: "2026-10-29", type: "late_arrival" as const, minutes: 60, today: "2026-10-30", joining: "2025-01-01", pastDays: 7, usedMinutes: 120, monthlyMinutes: 240, reason: "Doctor", sameDayType: false };
  it("partial day: minutes and the monthly allowance", () => {
    expect(validatePartial(partial)).toBeNull();
    expect(validatePartial({ ...partial, minutes: 10 })).toMatch(/15 minutes/);
    expect(validatePartial({ ...partial, minutes: 150 })).toMatch(/2h left/);
    expect(validatePartial({ ...partial, sameDayType: true })).toMatch(/already/);
  });
  it("leave portions for half days", () => {
    const l = { from_date: "2026-10-26", to_date: "2026-10-28", from_half: "second", to_half: "first" };
    expect([leavePortion("2026-10-26", l), leavePortion("2026-10-27", l), leavePortion("2026-10-28", l), leavePortion("2026-10-29", l)]).toEqual([0.5, 1, 0.5, 0]);
  });
});

describe("weekly-off grid", () => {
  it("round-trips patterns, collapsing uniform weekdays", async () => {
    const { gridFromPattern, patternFromGrid } = await import("./rules");
    const g = gridFromPattern({ sat: ["off", "work", "off", "work", "work"], sun: "off" });
    expect(g.sat).toEqual(["off", "work", "off", "work", "work"]);
    expect(g.sun).toEqual(["off", "off", "off", "off", "off"]);
    expect(g.mon).toEqual(["work", "work", "work", "work", "work"]);
    expect(patternFromGrid(g)).toEqual({ pattern: { sat: ["off", "work", "off", "work", "work"], sun: "off" }, error: null });
    expect(patternFromGrid({ ...g, sat: ["half", "half", "half", "half", "half"] }).pattern.sat).toBe("half");
    expect(patternFromGrid(Object.fromEntries(Object.keys(g).map((d) => [d, Array(5).fill("off")]))).error).toMatch(/working day/);
    expect(patternFromGrid({ ...g, mon: ["off"] }).error).toMatch(/weeks 1 to 5/);
  });
});
