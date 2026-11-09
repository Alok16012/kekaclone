import { describe, expect, it } from "vitest";
import {
  accrualPostings, accrualSchedule, addMonthsISO, applyAccrualStops, compOffExpiries, cycleEnd, cycleStart, inProbation, parseBalance, pickGrant, validateCompOff, yearEndSplit,
} from "./accrual-rules";

const person = (joining: string, extra: Partial<{ exit: string; probationEnd: string; probationStatus: string }> = {}) => ({ joining, ...extra });
const due = (s: ReturnType<typeof accrualSchedule>) => s.filter((p) => p.status === "due");

describe("leave years", () => {
  it("calendar and financial years", () => {
    expect(cycleStart("jan", "2020-05-10", "2026-10-30")).toBe("2026-01-01");
    expect(cycleStart("apr", "2020-05-10", "2026-03-31")).toBe("2025-04-01");
    expect(cycleStart("apr", "2020-05-10", "2026-04-01")).toBe("2026-04-01");
    expect(cycleEnd("2026-04-01")).toBe("2027-03-31");
  });
  it("joining-date years run from the work anniversary", () => {
    expect(cycleStart("joining_date", "2024-07-15", "2026-07-14")).toBe("2025-07-15");
    expect(cycleStart("joining_date", "2024-07-15", "2026-07-15")).toBe("2026-07-15");
    expect(cycleStart("joining_date", "2024-02-29", "2026-03-01")).toBe("2026-02-28");
  });
  it("adds months without spilling over short months", () => {
    expect(addMonthsISO("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsISO("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonthsISO("2026-03-01", -12)).toBe("2025-03-01");
  });
});

describe("monthly accrual", () => {
  const rule = { frequency: "monthly" as const, day: 1, prorate_joining: true };
  it("credits one twelfth on the credit day of each month, up to asOf", () => {
    const s = accrualSchedule({ quota: 12, rule, cycleStart: "2026-01-01", person: person("2020-01-01"), asOf: "2026-10-30" });
    expect(s).toHaveLength(12);
    expect(due(s)).toHaveLength(10);
    expect(due(s).every((p) => p.amount === 1)).toBe(true);
    expect(s[9]).toMatchObject({ periodId: "2026-10", creditDate: "2026-10-01", cumulative: 10 });
  });
  it("uses the configured day of month", () => {
    const s = accrualSchedule({ quota: 12, rule: { ...rule, day: 15 }, cycleStart: "2026-01-01", person: person("2020-01-01"), asOf: "2026-10-14" });
    expect(due(s)).toHaveLength(9);
    expect(s[9].creditDate).toBe("2026-10-15");
  });
  it("adds up exactly to the quota when it doesn't divide evenly", () => {
    const s = accrualSchedule({ quota: 15, rule, cycleStart: "2026-01-01", person: person("2020-01-01"), asOf: "2026-12-31" });
    expect(s.reduce((t, p) => t + p.amount, 0)).toBe(15);
    expect(s[11].cumulative).toBe(15);
    expect(s.map((p) => p.amount)).toContain(1.25);
  });
  it("prorates the joining month by days and credits nothing before joining", () => {
    const s = accrualSchedule({ quota: 12, rule, cycleStart: "2026-01-01", person: person("2026-10-16"), asOf: "2026-12-31" });
    expect(s.slice(0, 9).every((p) => p.status === "not_employed" && p.amount === 0)).toBe(true);
    expect(s[9]).toMatchObject({ creditDate: "2026-10-16", amount: 0.5 });   // 16 of 31 days
    expect(s[10].amount).toBe(1);
    const noProrate = accrualSchedule({ quota: 12, rule: { ...rule, prorate_joining: false }, cycleStart: "2026-01-01", person: person("2026-10-16"), asOf: "2026-12-31" });
    expect(noProrate[9].amount).toBe(1);
  });
  it("stops while on probation when the rule says so", () => {
    const p = person("2026-07-01", { probationEnd: "2026-10-01", probationStatus: "in_probation" });
    const s = accrualSchedule({ quota: 12, rule: { ...rule, stop_in_probation: true }, cycleStart: "2026-01-01", person: p, asOf: "2026-12-31" });
    expect(s.slice(6, 9).map((x) => x.status)).toEqual(["probation", "probation", "probation"]);
    expect(s[9]).toMatchObject({ status: "due", amount: 1 });
    expect(s[11].cumulative).toBe(3);
    // without the flag probation doesn't matter
    expect(accrualSchedule({ quota: 12, rule, cycleStart: "2026-01-01", person: p, asOf: "2026-12-31" })[11].cumulative).toBe(6);
  });
  it("stops after the exit date", () => {
    const s = accrualSchedule({ quota: 12, rule, cycleStart: "2026-01-01", person: person("2020-01-01", { exit: "2026-03-20" }), asOf: "2026-12-31" });
    expect(s.filter((x) => x.amount > 0)).toHaveLength(3);
  });
});

describe("quarterly, half-yearly and upfront accrual", () => {
  it("quarterly credits a quarter of the quota at the start of each quarter of an April year", () => {
    const s = accrualSchedule({ quota: 18, rule: { frequency: "quarterly", day: 1 }, cycleStart: "2026-04-01", person: person("2020-01-01"), asOf: "2026-10-30" });
    expect(s.map((p) => p.periodId)).toEqual(["2026-04-Q", "2026-07-Q", "2026-10-Q", "2027-01-Q"]);
    expect(due(s).map((p) => p.amount)).toEqual([4.5, 4.5, 4.5]);
  });
  it("quarterly prorates the joining quarter by days", () => {
    const s = accrualSchedule({ quota: 12, rule: { frequency: "quarterly", day: 1, prorate_joining: true }, cycleStart: "2026-01-01", person: person("2026-08-16"), asOf: "2026-12-31" });
    expect(s[2].amount).toBe(1.5);   // 3 × 46/92 days
    expect(s[3].amount).toBe(3);
  });
  it("half-yearly credits twice", () => {
    const s = accrualSchedule({ quota: 10, rule: { frequency: "half_yearly" }, cycleStart: "2026-01-01", person: person("2020-01-01"), asOf: "2026-12-31" });
    expect(s.map((p) => [p.creditDate, p.amount])).toEqual([["2026-01-01", 5], ["2026-07-01", 5]]);
  });
  it("upfront credits the whole year at once, prorated by months for mid-year joiners", () => {
    expect(due(accrualSchedule({ quota: 8, rule: { frequency: "upfront" }, cycleStart: "2026-01-01", person: person("2020-01-01"), asOf: "2026-01-01" }))[0].amount).toBe(8);
    const mid = accrualSchedule({ quota: 12, rule: { upfront: true }, cycleStart: "2026-01-01", person: person("2026-10-29"), asOf: "2026-10-29" });
    expect(mid).toEqual([expect.objectContaining({ periodId: "2026-01-Y", creditDate: "2026-10-29", amount: 3, status: "due" })]);
    expect(accrualSchedule({ quota: 18, rule: { frequency: "upfront" }, cycleStart: "2026-04-01", person: person("2026-10-29"), asOf: "2026-10-29" })[0].amount).toBe(9);
    expect(accrualSchedule({ quota: 15, rule: { frequency: "upfront" }, cycleStart: "2026-01-01", person: person("2026-12-10"), asOf: "2026-12-10" })[0].amount).toBe(1);
  });
  it("a future joiner's first period is due on the joining date", () => {
    const s = accrualSchedule({ quota: 12, rule: { frequency: "upfront" }, cycleStart: "2026-01-01", person: person("2026-11-02"), asOf: "2026-10-30" });
    expect(s[0].status).toBe("future");
  });
});

describe("accrual postings", () => {
  const sched = accrualSchedule({ quota: 12, rule: { frequency: "monthly" }, cycleStart: "2026-01-01", person: person("2020-01-01"), asOf: "2026-03-15" });
  it("posts each due period once", () => {
    expect(accrualPostings(sched, 0)).toEqual([
      { periodId: "2026-01", creditDate: "2026-01-01", amount: 1 }, { periodId: "2026-02", creditDate: "2026-02-01", amount: 1 }, { periodId: "2026-03", creditDate: "2026-03-01", amount: 1 }]);
  });
  it("is a no-op when everything due is already credited", () => expect(accrualPostings(sched, 3)).toEqual([]));
  it("never claws back or double credits when more was credited another way (e.g. an upfront opening)", () => expect(accrualPostings(sched, 12)).toEqual([]));
  it("catches up the difference after a quota increase", () => expect(accrualPostings(sched, 2.5)).toEqual([{ periodId: "2026-03", creditDate: "2026-03-01", amount: 0.5 }]));
});

describe("probation", () => {
  it("knows who was on probation on a day", () => {
    expect(inProbation({ joining: "2026-01-01", probationStatus: "in_probation", probationEnd: "2026-06-30" }, "2026-06-29")).toBe(true);
    expect(inProbation({ joining: "2026-01-01", probationStatus: "in_probation", probationEnd: "2026-06-30" }, "2026-06-30")).toBe(false);
    expect(inProbation({ joining: "2026-01-01", probationStatus: "confirmed", probationEnd: "2026-06-30" }, "2026-03-01")).toBe(true);
    expect(inProbation({ joining: "2026-01-01", probationStatus: "none" }, "2026-03-01")).toBe(false);
    expect(inProbation({ joining: "2026-01-01", probationStatus: "extended" }, "2027-03-01")).toBe(true);
  });
});

describe("year-end split", () => {
  it("reset lapses everything", () => expect(yearEndSplit(7, { action: "reset" })).toEqual({ carry: 0, encash: 0, lapse: 7 }));
  it("carry all", () => expect(yearEndSplit(7.5, { carry: "all" })).toEqual({ carry: 7.5, encash: 0, lapse: 0 }));
  it("carry up to N, encash up to M, lapse the rest", () => {
    expect(yearEndSplit(20, { carry: "upto", carry_max: 10, encash_max: 5 })).toEqual({ carry: 10, encash: 5, lapse: 5 });
    expect(yearEndSplit(12, { carry: "upto", carry_max: 10, encash_max: 5 })).toEqual({ carry: 10, encash: 2, lapse: 0 });
    expect(yearEndSplit(4, { carry: "upto", carry_max: 10 })).toEqual({ carry: 4, encash: 0, lapse: 0 });
  });
  it("encash without carry", () => expect(yearEndSplit(9, { carry: "none", encash_max: 6 })).toEqual({ carry: 0, encash: 6, lapse: 3 }));
  it("a negative balance carries into the new year as it is", () => expect(yearEndSplit(-2, { carry: "none" })).toEqual({ carry: -2, encash: 0, lapse: 0 }));
  it("zero does nothing", () => expect(yearEndSplit(0, { carry: "all" })).toEqual({ carry: 0, encash: 0, lapse: 0 }));
});

describe("comp-off expiry (first in, first out)", () => {
  const credits = [{ id: "a", amount: 1, expiresOn: "2026-10-01" }, { id: "b", amount: 1, expiresOn: "2026-11-30" }];
  it("expires the unused part of a lapsed credit", () => expect(compOffExpiries({ outstanding: 2, credits, asOf: "2026-10-30" })).toEqual([{ id: "a", amount: 1 }]));
  it("a day already taken used the oldest credit first, so nothing is left to expire", () =>
    expect(compOffExpiries({ outstanding: 1, credits, asOf: "2026-10-30" })).toEqual([{ id: "a", amount: 0 }]));
  it("credits valid through today haven't expired yet", () => expect(compOffExpiries({ outstanding: 2, credits, asOf: "2026-10-01" })).toEqual([]));
  it("several expire in order; credits with no expiry count as newest", () => {
    expect(compOffExpiries({ outstanding: 2.5, neverExpiring: 1, credits, asOf: "2026-12-15" })).toEqual([{ id: "a", amount: 0.5 }, { id: "b", amount: 1 }]);
  });
  it("never expires more than the credit or below zero", () => expect(compOffExpiries({ outstanding: -1, credits, asOf: "2026-12-15" })).toEqual([{ id: "a", amount: 0 }, { id: "b", amount: 0 }]));
});

describe("comp-off claims", () => {
  const base = { today: "2026-10-30", windowDays: 30, dayTypes: { "2026-10-24": "weekly_off", "2026-10-26": "working", "2026-10-02": "holiday", "2026-11-01": "weekly_off" }, claimed: new Set<string>() };
  it("accepts a recent weekly off", () => expect(validateCompOff({ ...base, dates: ["2026-10-24"] })).toEqual([]));
  it("refuses working days, future days, old days and repeats", () => {
    expect(validateCompOff({ ...base, dates: ["2026-10-26"] }).map((v) => v.code)).toEqual(["working"]);
    expect(validateCompOff({ ...base, dates: ["2026-11-01"] }).map((v) => v.code)).toEqual(["future"]);
    expect(validateCompOff({ ...base, windowDays: 7, dates: ["2026-10-02"] }).map((v) => v.code)).toEqual(["window"]);
    expect(validateCompOff({ ...base, dates: ["2026-10-24"], claimed: new Set(["2026-10-24"]) }).map((v) => v.code)).toEqual(["claimed"]);
    expect(validateCompOff({ ...base, dates: [] }).map((v) => v.code)).toEqual(["empty"]);
  });
});

describe("balance import values", () => {
  it("accepts numbers and numeric text with up to 2 decimals", () => {
    expect(parseBalance(4.5)).toBe(4.5); expect(parseBalance(" 3 ")).toBe(3); expect(parseBalance(1.1)).toBe(1.1); expect(parseBalance(-2)).toBe(-2);
  });
  it("rejects blanks, text and silly values", () => {
    expect(parseBalance("")).toBeNull(); expect(parseBalance("ten")).toBeNull(); expect(parseBalance(1.234)).toBeNull(); expect(parseBalance(5000)).toBeNull(); expect(parseBalance(null)).toBeNull();
  });
});

describe("accrual stop rules", () => {
  const due = [{ periodId: "2026-01", creditDate: "2026-01-01", amount: 1 }, { periodId: "2026-02", creditDate: "2026-02-01", amount: 1 }, { periodId: "2026-03", creditDate: "2026-03-01", amount: 1 }];
  it("credits everything when no rule is set", () => {
    const out = applyAccrualStops(due, { balance: 10, taken: 5 });
    expect(out.map((o) => o.credited)).toEqual([1, 1, 1]);
    expect(out.every((o) => o.withheld === 0 && o.reason === null)).toBe(true);
  });
  it("stops at the balance cap, crediting only the room left and carrying the running balance", () => {
    const out = applyAccrualStops(due, { balance: 10.5, taken: 0, cap: 12 });
    expect(out.map((o) => [o.credited, o.withheld, o.reason])).toEqual([[1, 0, null], [0.5, 0.5, "cap"], [0, 1, "cap"]]);
  });
  it("credits nothing once the balance already sits above the cap", () => {
    const out = applyAccrualStops(due, { balance: 15, taken: 0, cap: 12 });
    expect(out.map((o) => o.credited)).toEqual([0, 0, 0]);
    expect(out.map((o) => o.withheld)).toEqual([1, 1, 1]);
  });
  it("stops for the rest of the year after N days taken", () => {
    expect(applyAccrualStops(due, { balance: 2, taken: 6, stopAfterTaken: 6 }).map((o) => o.reason)).toEqual(["taken", "taken", "taken"]);
    expect(applyAccrualStops(due, { balance: 2, taken: 5.5, stopAfterTaken: 6 }).map((o) => o.credited)).toEqual([1, 1, 1]);
  });
  it("ignores negative or missing limits", () => {
    expect(applyAccrualStops(due, { balance: 100, taken: 100, cap: -1, stopAfterTaken: null }).map((o) => o.credited)).toEqual([1, 1, 1]);
  });
});

describe("event-based grants", () => {
  const g = (id: string, days: number, used: number, from: string, to: string) => ({ id, days, used, validFrom: from, validTo: to });
  it("needs a grant", () => {
    expect(pickGrant([], { from: "2026-05-01", to: "2026-05-03", days: 3 }).problem).toMatch(/Ask HR/);
  });
  it("uses a grant that covers the dates and has days left", () => {
    const r = pickGrant([g("a", 5, 0, "2026-04-20", "2026-05-20")], { from: "2026-05-01", to: "2026-05-05", days: 5 });
    expect(r.grant?.id).toBe("a");
  });
  it("rejects dates outside every window and says which window exists", () => {
    const r = pickGrant([g("a", 5, 0, "2026-04-20", "2026-05-20")], { from: "2026-05-19", to: "2026-05-22", days: 4 });
    expect(r.grant).toBeNull(); expect(r.problem).toMatch(/2026-04-20 to 2026-05-20/);
  });
  it("rejects when what's left is too little", () => {
    const r = pickGrant([g("a", 5, 3, "2026-04-20", "2026-05-20")], { from: "2026-05-01", to: "2026-05-03", days: 3 });
    expect(r.grant).toBeNull(); expect(r.problem).toMatch(/Only 2 days are left/);
  });
  it("prefers the grant that ends first when several fit", () => {
    const r = pickGrant([g("late", 5, 0, "2026-04-01", "2026-12-31"), g("early", 5, 0, "2026-04-01", "2026-06-30")], { from: "2026-05-01", to: "2026-05-02", days: 2 });
    expect(r.grant?.id).toBe("early");
  });
});
