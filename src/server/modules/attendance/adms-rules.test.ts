import { describe, expect, it } from "vitest";
import { admsDirection, admsLocalToInstant, admsOptions, admsSerial, attlogToPunches, parseAttlog } from "./adms-rules";

describe("ADMS push protocol", () => {
  it("maps the device's STATUS column to a direction", () => {
    expect(admsDirection("0")).toBe("in"); expect(admsDirection("1")).toBe("out");
    expect(admsDirection("4")).toBe("in"); expect(admsDirection("5")).toBe("out");
    expect(admsDirection("255")).toBe("auto"); expect(admsDirection(undefined)).toBe("auto");
  });
  it("turns device-local time into an instant using the device's zone and clock offset", () => {
    expect(admsLocalToInstant("2026-11-03 09:31:05", "Asia/Kolkata")?.toISOString()).toBe("2026-11-03T04:01:05.000Z");
    expect(admsLocalToInstant("2026-11-03 09:31:05", "Asia/Kolkata", 120)?.toISOString()).toBe("2026-11-03T03:59:05.000Z");   // device runs 2 min fast
    expect(admsLocalToInstant("2026-11-03 09:31", "Asia/Dubai")?.toISOString()).toBe("2026-11-03T05:31:00.000Z");
    expect(admsLocalToInstant("not a time", "Asia/Kolkata")).toBeNull();
    expect(admsLocalToInstant("2026-11-03 09:31:05", "Mars/Olympus")).toBeNull();
  });
  it("parses ATTLOG lines and skips junk", () => {
    const body = "42\t2026-11-03 09:31:05\t0\t1\t0\t0\n\n7\t2026-11-03 18:40:00\t1\t1\nbroken line\n\t2026-11-03 10:00:00\t0\n";
    const r = parseAttlog(body);
    expect(r.rows.map((x) => x.pin)).toEqual(["42", "7"]);
    expect(r.rows[0].status).toBe("0");
    expect(r.bad).toBe(2);
  });
  it("builds idempotent punches: the same log line twice counts once", () => {
    const rows = parseAttlog("42\t2026-11-03 09:31:05\t0\t1\n42\t2026-11-03 09:31:05\t0\t1\n42\t2026-11-03 18:40:00\t1\t1\n").rows;
    const { items, badTime } = attlogToPunches(rows, "Asia/Kolkata");
    expect(badTime).toBe(0);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ employee: "42", direction: "in", external_id: "42@2026-11-03 09:31:05", at: "2026-11-03T04:01:05.000Z" });
    expect(items[1].direction).toBe("out");
  });
  it("accepts only sane serial numbers", () => {
    expect(admsSerial(" AEXC123456 ")).toBe("AEXC123456");
    expect(admsSerial("a")).toBeNull(); expect(admsSerial("x y")).toBeNull(); expect(admsSerial(null)).toBeNull();
  });
  it("answers the handshake with the options block", () => {
    const o = admsOptions("AEXC123456", { attlog: 0 });
    expect(o).toMatch(/^GET OPTION FROM: AEXC123456\n/);
    expect(o).toMatch(/ATTLOGStamp=0\n/); expect(o).toMatch(/Realtime=1/); expect(o).toMatch(/TimeZone=5\.5/);
    expect(admsOptions("X1", { tz: "Asia/Dubai" })).toMatch(/TimeZone=4\n/);
  });
});
