import { describe, expect, it } from "vitest";
import {
  canMoveInvoice, DEFAULT_POLICY, formatMinutes, isWeekLocked, isWeekStart, parseDuration, projectCodeFrom, summarize, timesheetActions, tmLines, totals,
  validateGrid, validatePolicy, validateProject, validateSubmit, weekDays, weekStartOf, type GridRow,
} from "./rules";

const row = (minutes: number[], extra: Partial<GridRow> = {}): GridRow => ({ projectId: "p1", taskId: null, billable: true, note: "", minutes, ...extra });

describe("weeks", () => {
  it("finds the Monday of any date", () => {
    expect(weekStartOf("2026-11-03")).toBe("2026-11-02");   // Tuesday → Monday
    expect(weekStartOf("2026-11-08")).toBe("2026-11-02");   // Sunday belongs to the week before
    expect(weekStartOf("2026-11-02")).toBe("2026-11-02");
    expect(isWeekStart("2026-11-02")).toBe(true);
    expect(isWeekStart("2026-11-03")).toBe(false);
    expect(weekDays("2026-11-02")).toHaveLength(7);
    expect(weekDays("2026-11-02")[6]).toBe("2026-11-08");
  });
  it("locks weeks older than the policy allows", () => {
    expect(isWeekLocked("2026-10-05", "2026-11-03", 7)).toBe(true);
    expect(isWeekLocked("2026-10-26", "2026-11-03", 7)).toBe(false);
    expect(isWeekLocked("2020-01-06", "2026-11-03", null)).toBe(false);
    expect(isWeekLocked("2026-10-26", "2026-11-02", 0)).toBe(true);
  });
});

describe("durations", () => {
  it("parses the ways people type hours", () => {
    expect(parseDuration("8")).toBe(480);
    expect(parseDuration("8.5")).toBe(510);
    expect(parseDuration("8:30")).toBe(510);
    expect(parseDuration("1h 15m")).toBe(75);
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("")).toBe(0);
    expect(parseDuration("eight")).toBeNull();
    expect(parseDuration("8:75")).toBeNull();
    expect(formatMinutes(510)).toBe("8:30");
    expect(formatMinutes(0)).toBe("0:00");
  });
});

describe("grid validation", () => {
  const ctx = { weekStart: "2026-10-26", today: "2026-11-03" };
  it("accepts a normal week", () => {
    expect(validateGrid([row([480, 480, 480, 480, 480, 0, 0])], DEFAULT_POLICY, ctx)).toEqual([]);
  });
  it("rejects over the daily limit, future days, duplicate rows and bad numbers", () => {
    const p = validateGrid([row([800, 0, 0, 0, 0, 0, 0]), row([0, 0, 0, 0, 0, 0, 0]), row([0, -1, 0, 0, 0, 0, 0], { taskId: "t1" })], DEFAULT_POLICY, ctx);
    expect(p.map((x) => x.field)).toEqual(expect.arrayContaining(["rows.1", "rows.2.1", "day.0"]));
    const fut = validateGrid([row([0, 0, 0, 0, 0, 0, 60])], DEFAULT_POLICY, { weekStart: "2026-11-02", today: "2026-11-03" });
    expect(fut[0].message).toMatch(/hasn't happened/);
    expect(validateGrid([row([0, 0, 0, 0, 0, 0, 60])], { ...DEFAULT_POLICY, allow_future: true }, { weekStart: "2026-11-02", today: "2026-11-03" })).toEqual([]);
  });
  it("requires a note when the policy says so", () => {
    expect(validateGrid([row([60, 0, 0, 0, 0, 0, 0])], { ...DEFAULT_POLICY, require_note: true }, ctx)[0].field).toBe("rows.0.note");
    expect(validateGrid([row([60, 0, 0, 0, 0, 0, 0], { note: "API work" })], { ...DEFAULT_POLICY, require_note: true }, ctx)).toEqual([]);
  });
  it("enforces minimums only on submit, weekdays only, never on days still ahead", () => {
    const daily = { ...DEFAULT_POLICY, cadence: "daily" as const, min_minutes_per_day: 480 };
    expect(validateSubmit([row([480, 480, 480, 480, 480, 0, 0])], daily, ctx)).toEqual([]);
    expect(validateSubmit([row([480, 240, 480, 480, 480, 0, 0])], daily, ctx).map((p) => p.field)).toEqual(["day.1"]);
    expect(validateSubmit([row([480, 480, 0, 0, 0, 0, 0])], daily, { weekStart: "2026-11-02", today: "2026-11-03" })).toEqual([]);
    const weekly = { ...DEFAULT_POLICY, min_minutes_per_week: 2400 };
    expect(validateSubmit([row([480, 480, 480, 480, 0, 0, 0])], weekly, ctx)[0].message).toMatch(/weekly minimum/);
    expect(validateSubmit([row([0, 0, 0, 0, 0, 0, 0])], DEFAULT_POLICY, ctx)[0].message).toMatch(/Log some hours/);
  });
});

describe("timesheet actions", () => {
  it("lets the owner edit drafts and sent-back weeks, never approved or locked ones", () => {
    expect(timesheetActions({ status: "draft", locked: false, invoiced: false }, { owner: true, admin: false })).toMatchObject({ edit: true, submit: true, withdraw: false, reopen: false });
    expect(timesheetActions({ status: "rejected", locked: false, invoiced: false }, { owner: true, admin: false }).edit).toBe(true);
    expect(timesheetActions({ status: "draft", locked: true, invoiced: false }, { owner: true, admin: false }).edit).toBe(false);
    expect(timesheetActions({ status: "submitted", locked: false, invoiced: false }, { owner: true, admin: false })).toMatchObject({ edit: false, withdraw: true });
    expect(timesheetActions({ status: "approved", locked: false, invoiced: false }, { owner: true, admin: true })).toMatchObject({ edit: false, reopen: true });
    expect(timesheetActions({ status: "approved", locked: false, invoiced: true }, { owner: false, admin: true }).reopen).toBe(false);
  });
});

describe("invoices", () => {
  it("builds T&M lines per person and flags missing rates", () => {
    const { lines, missingRates } = tmLines([
      { employee_id: "a", employee: "Asha", minutes: 90, bill_rate_paise: 200000 },
      { employee_id: "a", employee: "Asha", minutes: 30, bill_rate_paise: 200000 },
      { employee_id: "b", employee: "Rohan", minutes: 60, bill_rate_paise: null },
    ]);
    expect(lines).toEqual([
      { description: "Asha · 2 h", quantity: 2, unit_paise: 200000, amount_paise: 400000, employee_id: "a" },
      { description: "Rohan · 1 h", quantity: 1, unit_paise: 0, amount_paise: 0, employee_id: "b" },
    ]);
    expect(missingRates).toEqual(["Rohan"]);
    expect(totals(lines, 1800)).toEqual({ subtotal: 400000, tax: 72000, total: 472000 });
    expect(totals(lines, 0).tax).toBe(0);
  });
  it("moves draft → sent → paid, void from draft or sent only", () => {
    expect(canMoveInvoice("draft", "sent")).toBe(true);
    expect(canMoveInvoice("draft", "paid")).toBe(false);
    expect(canMoveInvoice("sent", "paid")).toBe(true);
    expect(canMoveInvoice("sent", "void")).toBe(true);
    expect(canMoveInvoice("paid", "void")).toBe(false);
    expect(canMoveInvoice("void", "sent")).toBe(false);
  });
  it("summarises entries", () => {
    const s = summarize([{ minutes: 60, is_billable: true, project_id: "p" }, { minutes: 30, is_billable: false, project_id: "q" }]);
    expect(s).toMatchObject({ total: 90, billable: 60 });
    expect(s.byProject.get("q")).toBe(30);
  });
});

describe("setup validation", () => {
  it("derives project codes and validates projects", () => {
    expect(projectCodeFrom("Acme Website Revamp")).toBe("AWR");
    expect(projectCodeFrom("Internal")).toBe("INTERN");
    expect(projectCodeFrom("")).toBe("PRJ");
    const base = { name: "X", code: "AWR", billingModel: "retainer", retainerPaise: 0, startDate: "2026-01-10", endDate: "2026-01-01", currency: "INR" };
    expect(validateProject(base).map((p) => p.field)).toEqual(["retainerPaise", "endDate"]);
    expect(validateProject({ ...base, code: "aw", billingModel: "x", currency: "rupee" }).map((p) => p.field)).toEqual(expect.arrayContaining(["code", "billingModel", "currency"]));
  });
  it("validates the policy", () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
    expect(validatePolicy({ ...DEFAULT_POLICY, min_minutes_per_day: 800, max_minutes_per_day: 600 })[0].field).toBe("min_minutes_per_day");
    expect(validatePolicy({ ...DEFAULT_POLICY, lock_after_days: 999 })[0].field).toBe("lock_after_days");
  });
});
