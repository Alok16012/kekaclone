import { describe, expect, it } from "vitest";
import { clockIn, parseTime, shouldRun } from "./scheduler-rules";

const cfg = { time: "00:15", tz: "Asia/Kolkata", repeatMinutes: 0 };
const at = (iso: string) => new Date(iso);

describe("scheduler decision", () => {
  it("parses HH:MM and falls back", () => {
    expect(parseTime("1:05")).toBe("01:05"); expect(parseTime("23:59")).toBe("23:59");
    expect(parseTime("24:00")).toBe("00:15"); expect(parseTime(undefined)).toBe("00:15"); expect(parseTime("abc", "02:00")).toBe("02:00");
  });
  it("tells the local time", () => {
    expect(clockIn("Asia/Kolkata", at("2026-11-02T18:45:00Z"))).toBe("00:15");
    expect(clockIn("UTC", at("2026-11-02T18:45:00Z"))).toBe("18:45");
  });
  it("waits until the configured time, then runs once that day", () => {
    const before = at("2026-11-02T18:40:00Z");   // 00:10 IST on 3 Nov
    expect(shouldRun(cfg, { lastRunDate: "2026-11-02", lastRunAt: null }, before)).toMatchObject({ run: false, date: "2026-11-03" });
    const due = at("2026-11-02T18:45:00Z");      // 00:15 IST
    expect(shouldRun(cfg, { lastRunDate: "2026-11-02", lastRunAt: null }, due)).toMatchObject({ run: true, why: "first run of 2026-11-03" });
    expect(shouldRun(cfg, { lastRunDate: "2026-11-03", lastRunAt: due.getTime() }, at("2026-11-03T05:00:00Z"))).toMatchObject({ run: false, why: "already ran today" });
  });
  it("catches up when started late in the day, and never runs twice without repeat", () => {
    expect(shouldRun(cfg, { lastRunDate: null, lastRunAt: null }, at("2026-11-03T10:00:00Z"))).toMatchObject({ run: true, why: "first run since start" });
  });
  it("repeats on the interval when asked", () => {
    const c = { ...cfg, repeatMinutes: 60 };
    const first = at("2026-11-03T05:00:00Z").getTime();
    expect(shouldRun(c, { lastRunDate: "2026-11-03", lastRunAt: first }, at("2026-11-03T05:30:00Z")).run).toBe(false);
    expect(shouldRun(c, { lastRunDate: "2026-11-03", lastRunAt: first }, at("2026-11-03T06:00:00Z"))).toMatchObject({ run: true, why: "repeat every 60 min" });
  });
});
