import { describe, expect, it } from "vitest";
import { allowedActions, dueAt, escalationsDue, formatMinutes, nextStatus, pickAssignee, slaState, ticketRef, validateCategory } from "./rules";

const at = (s: string) => new Date(`2026-10-30T${s}:00+05:30`);
const base = { status: "open" as const, first_response_due_at: at("10:00"), first_responded_at: null, resolution_due_at: at("18:00"), closed_at: null };

describe("ticket states", () => {
  it("open → in progress → closed → reopened", () => {
    expect(nextStatus("open", "start")).toBe("in_progress");
    expect(nextStatus("in_progress", "close")).toBe("closed");
    expect(nextStatus("open", "close")).toBe("closed");
    expect(nextStatus("closed", "reopen")).toBe("open");
  });
  it("refuses moves that don't apply", () => {
    expect(nextStatus("closed", "close")).toBeNull();
    expect(nextStatus("in_progress", "start")).toBeNull();
    expect(nextStatus("open", "reopen")).toBeNull();
  });
  it("requesters can close and reopen but not start work", () => {
    expect(allowedActions("open", "requester")).toEqual(["close"]);
    expect(allowedActions("open", "agent")).toEqual(["start", "close"]);
    expect(allowedActions("closed", "requester")).toEqual(["reopen"]);
  });
});

describe("SLA clocks", () => {
  it("due times from minutes; no target → null", () => {
    expect(dueAt(at("09:00"), 90)?.toISOString()).toBe(at("10:30").toISOString());
    expect(dueAt(at("09:00"), null)).toBeNull();
    expect(dueAt(at("09:00"), 0)).toBeNull();
  });
  it("on track, due soon, breached", () => {
    expect(slaState(base, at("08:30")).first).toBe("on_track");
    expect(slaState(base, at("09:30")).first).toBe("due_soon");
    expect(slaState(base, at("10:01"))).toEqual({ first: "breached", resolution: "on_track", breached: true });
  });
  it("met when answered / closed in time, breached when late", () => {
    expect(slaState({ ...base, first_responded_at: at("09:59") }, at("20:00")).first).toBe("met");
    expect(slaState({ ...base, first_responded_at: at("10:30") }, at("10:31")).first).toBe("breached");
    expect(slaState({ ...base, status: "closed", first_responded_at: at("09:00"), closed_at: at("17:00") }, at("23:00"))).toEqual({ first: "met", resolution: "met", breached: false });
    expect(slaState({ ...base, status: "closed", first_responded_at: at("09:00"), closed_at: at("19:00") }, at("23:00")).resolution).toBe("breached");
  });
  it("closing without a reply counts as the first response", () => {
    expect(slaState({ ...base, status: "closed", closed_at: at("09:30") }, at("23:00")).first).toBe("met");
  });
  it("no targets → none, never breached", () => {
    expect(slaState({ ...base, first_response_due_at: null, resolution_due_at: null }, at("23:00"))).toEqual({ first: "none", resolution: "none", breached: false });
  });
});

describe("escalation", () => {
  const t = { ...base, first_response_escalated_at: null, resolution_escalated_at: null };
  it("only once per target, only when breached, never when closed", () => {
    expect(escalationsDue(t, at("09:00"))).toEqual([]);
    expect(escalationsDue(t, at("10:05"))).toEqual(["first_response"]);
    expect(escalationsDue(t, at("18:05"))).toEqual(["first_response", "resolution"]);
    expect(escalationsDue({ ...t, first_response_escalated_at: at("10:05") }, at("18:05"))).toEqual(["resolution"]);
    expect(escalationsDue({ ...t, first_responded_at: at("09:30") }, at("10:05"))).toEqual([]);
    expect(escalationsDue({ ...t, status: "closed", closed_at: at("17:00") }, at("19:00"))).toEqual([]);
  });
});

describe("auto-assign", () => {
  it("least busy agent, ties to the first listed, never the requester", () => {
    expect(pickAssignee(["a", "b", "c"], { a: 3, b: 1, c: 1 }, "x")).toBe("b");
    expect(pickAssignee(["a", "b"], { a: 0, b: 0 }, "x")).toBe("a");
    expect(pickAssignee(["a", "b"], { a: 0, b: 5 }, "a")).toBe("b");
    expect(pickAssignee(["a"], { a: 0 }, "a")).toBeNull();
    expect(pickAssignee([], {}, "a")).toBeNull();
  });
});

describe("categories", () => {
  const ok = { name: "IT", priority: "high", firstResponseMins: 60, resolutionMins: 480, assigneeIds: ["a"], escalateToId: null };
  it("accepts a sound category", () => expect(validateCategory(ok)).toEqual([]));
  it("flags bad names, priorities, SLAs and duplicates", () => {
    expect(validateCategory({ ...ok, name: " " })[0].field).toBe("name");
    expect(validateCategory({ ...ok, priority: "urgent" })[0].field).toBe("priority");
    expect(validateCategory({ ...ok, firstResponseMins: -5 })[0].field).toBe("firstResponseMins");
    expect(validateCategory({ ...ok, firstResponseMins: 1.5 })[0].field).toBe("firstResponseMins");
    expect(validateCategory({ ...ok, resolutionMins: 30 })[0].field).toBe("resolutionMins");
    expect(validateCategory({ ...ok, resolutionMins: 200 * 24 * 60 })[0].field).toBe("resolutionMins");
    expect(validateCategory({ ...ok, assigneeIds: ["a", "a"] })[0].field).toBe("assigneeIds");
    expect(validateCategory({ ...ok, firstResponseMins: null, resolutionMins: null })).toEqual([]);
  });
  it("formats SLA minutes and ticket numbers", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(240)).toBe("4 h");
    expect(formatMinutes(1440 + 360)).toBe("1 day 6 h");
    expect(formatMinutes(2880)).toBe("2 days");
    expect(formatMinutes(null)).toBe("No target");
    expect(ticketRef(7)).toBe("HD-0007");
    expect(ticketRef(BigInt(12345))).toBe("HD-12345");
  });
});
