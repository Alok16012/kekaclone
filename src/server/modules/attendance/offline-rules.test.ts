import { describe, expect, it } from "vitest";
import { parseQueue, planQueuedPunches } from "./offline-rules";

const now = new Date("2026-11-03T12:00:00Z");
const p = (id: string, expect: "in" | "out", at: string) => ({ client_id: id, expect, at });

describe("offline punch queue", () => {
  it("applies punches oldest first and keeps in/out alternating with the server's last punch", () => {
    const plan = planQueuedPunches([p("b-00000001", "out", "2026-11-03T11:00:00Z"), p("a-00000001", "in", "2026-11-03T09:00:00Z")], { lastDirection: "out", lastAt: "2026-11-02T18:00:00Z", now });
    expect(plan.accept.map((x) => x.client_id)).toEqual(["a-00000001", "b-00000001"]);
    expect(plan.reject).toEqual([]);
  });
  it("refuses a second clock-in, a clock-out while out, duplicates, future and stale punches, and anything before the last server punch", () => {
    const plan = planQueuedPunches([
      p("in-00000001", "in", "2026-11-03T09:00:00Z"), p("in-00000002", "in", "2026-11-03T09:30:00Z"), p("in-00000001", "in", "2026-11-03T09:00:00Z"),
      p("fut-0000001", "out", "2026-11-03T13:00:00Z"), p("old-0000001", "in", "2026-10-30T09:00:00Z"), p("pre-0000001", "in", "2026-11-02T17:00:00Z"),
    ], { lastDirection: "out", lastAt: "2026-11-02T18:00:00Z", now });
    expect(plan.accept.map((x) => x.client_id)).toEqual(["in-00000001"]);
    expect(Object.fromEntries(plan.reject.map((r) => [r.client_id, r.reason]))).toEqual({
      "in-00000002": "already clocked in at that time", "fut-0000001": "in the future", "old-0000001": "older than 48 hours", "pre-0000001": "earlier than a punch already recorded",
      "in-00000001": "duplicate",
    });
  });
  it("first punch ever must be a clock-in", () => {
    expect(planQueuedPunches([p("x-000000001", "out", "2026-11-03T11:00:00Z")], { lastDirection: null, lastAt: null, now }).reject[0].reason).toBe("not clocked in at that time");
  });
  it("parses untrusted input, dropping bad rows", () => {
    const r = parseQueue([{ client_id: "ok-00000001", expect: "in", at: "2026-11-03T09:00:00Z", lat: 12.9, lng: "x" }, { client_id: "bad", expect: "in", at: "2026-11-03T09:00:00Z" }, { client_id: "ok-00000002", expect: "sideways", at: "x" }, { client_id: "ok-00000003", expect: "out", at: "nope" }]);
    expect(r.items).toEqual([{ client_id: "ok-00000001", expect: "in", at: "2026-11-03T09:00:00.000Z", lat: 12.9, lng: null, accuracy: null, comment: null }]);
    expect(r.bad.map((b) => b.reason)).toEqual(["missing id", "missing direction", "bad time"]);
    expect(parseQueue("junk").items).toEqual([]);
  });
});
