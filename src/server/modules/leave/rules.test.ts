import { describe, expect, it } from "vitest";
import { countLeaveDays, validateRequest, proratedOpening, dayType, type Calendar } from "./rules";

// Nov 2026: Sat 7, Sun 8, Sat 14, Sun 15; Mon 9 = holiday in this calendar
const cal: Calendar = { holidays: new Set(["2026-11-09"]), weeklyOff: { sat: "off", sun: "off" } };
const alt: Calendar = { holidays: new Set(), weeklyOff: { sun: "off", sat: ["work", "off", "work", "off", "work"] } };

describe("dayType", () => {
  it("knows holidays, weekends and 2nd/4th Saturdays", () => {
    expect(dayType("2026-11-09", cal)).toBe("holiday");
    expect(dayType("2026-11-07", cal)).toBe("weekly_off");
    expect(dayType("2026-11-06", cal)).toBe("working");
    expect(dayType("2026-11-07", alt)).toBe("working");   // 1st Saturday
    expect(dayType("2026-11-14", alt)).toBe("weekly_off"); // 2nd Saturday
  });
});

describe("countLeaveDays", () => {
  it("counts a single full day", () => expect(countLeaveDays("2026-11-04", "2026-11-04", "full", "full", cal).days).toBe(1));
  it("counts a single half day either half", () => {
    expect(countLeaveDays("2026-11-04", "2026-11-04", "first", "first", cal).days).toBe(0.5);
    expect(countLeaveDays("2026-11-04", "2026-11-04", "second", "full", cal).days).toBe(0.5);
  });
  it("skips weekends and holidays without the sandwich rule", () => {
    // Fri 6 .. Tue 10: Fri, (Sat, Sun, Mon holiday), Tue = 2
    expect(countLeaveDays("2026-11-06", "2026-11-10", "full", "full", cal).days).toBe(2);
  });
  it("sandwich counts off days between two leave days", () => {
    const r = countLeaveDays("2026-11-06", "2026-11-10", "full", "full", cal, { sandwich: { enabled: true } });
    expect(r.days).toBe(5);
    expect(r.breakdown.filter((d) => d.why === "sandwich").map((d) => d.date)).toEqual(["2026-11-07", "2026-11-08", "2026-11-09"]);
  });
  it("sandwich never charges off days at the edges of the range", () => {
    expect(countLeaveDays("2026-11-07", "2026-11-10", "full", "full", cal, { sandwich: { enabled: true } }).days).toBe(1);
  });
  it("sandwich can ignore half-day neighbours", () => {
    const r = countLeaveDays("2026-11-06", "2026-11-10", "second", "full", cal, { sandwich: { enabled: true, ignoreHalfDays: true } });
    expect(r.days).toBe(1.5);
  });
  it("half start and half end on a multi-day range", () => {
    expect(countLeaveDays("2026-11-03", "2026-11-05", "second", "first", cal).days).toBe(2);
  });
  it("returns zero for a range of only off days", () => expect(countLeaveDays("2026-11-07", "2026-11-09", "full", "full", cal).days).toBe(0));
});

describe("validateRequest", () => {
  const base = { from: "2026-11-04", to: "2026-11-05", fromPart: "full" as const, toPart: "full" as const, days: 2, today: "2026-10-29", available: 5, hasAttachment: false, rules: { allowHalfDay: true, backdateDays: 7 } };
  it("passes a normal request", () => expect(validateRequest(base)).toEqual([]));
  it("blocks when balance is short", () => expect(validateRequest({ ...base, available: 1 }).map((v) => v.code)).toEqual(["balance"]));
  it("warns, not blocks, inside the negative limit", () => {
    const v = validateRequest({ ...base, available: 1, rules: { ...base.rules, negativeLimit: 2 } });
    expect(v).toEqual([expect.objectContaining({ code: "negative", blocking: false })]);
  });
  it("enforces notice period", () => expect(validateRequest({ ...base, rules: { ...base.rules, noticeDays: 10 } })[0].code).toBe("notice"));
  it("enforces backdating window", () => {
    expect(validateRequest({ ...base, from: "2026-10-01", to: "2026-10-01", days: 1 })[0].code).toBe("backdate");
    expect(validateRequest({ ...base, from: "2026-10-25", to: "2026-10-25", days: 1 })).toEqual([]);
  });
  it("blocks half days when not allowed", () => expect(validateRequest({ ...base, fromPart: "second", rules: { backdateDays: 7 } })[0].code).toBe("half"));
  it("requires an attachment for long requests", () => expect(validateRequest({ ...base, rules: { ...base.rules, attachmentAfterDays: 1 } })[0].code).toBe("attachment"));
});

describe("proratedOpening", () => {
  it("full quota when joining in the first month", () => expect(proratedOpening(12, "2026-01-15", 1)).toBe(12));
  it("prorates mid-year, rounded down to half days", () => {
    expect(proratedOpening(12, "2026-10-29", 1)).toBe(3);   // Oct, Nov, Dec
    expect(proratedOpening(18, "2026-10-29", 4)).toBe(9);   // Oct..Mar = 6 months of an Apr–Mar year
    expect(proratedOpening(15, "2026-12-10", 1)).toBe(1);   // 1 month of 15 = 1.25 → 1
  });
});
