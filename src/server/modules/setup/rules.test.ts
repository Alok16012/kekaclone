import { describe, expect, it } from "vitest";
import { checkCompany, checkLeaveBasics, finish, markStep, nextStep, normalize, progress, shouldAutoOpen, showChecklist, start, STEP_KEYS } from "./rules";

const T = "2026-10-30T10:00:00.000Z", T2 = "2026-10-30T11:00:00.000Z";

describe("setup state", () => {
  it("normalizes legacy and junk state", () => {
    expect(normalize({})).toEqual({ status: "none", steps: {} });
    expect(normalize(null)).toEqual({ status: "none", steps: {} });
    expect(normalize({ status: "pending", steps: { company: { status: "nope" }, bogus: { status: "done" } } })).toEqual({ status: "pending", steps: {} });
    expect(normalize({ status: "started", startedAt: T, steps: { leave: { status: "skipped", at: T } } }).steps).toEqual({ leave: { status: "skipped", at: T } });
  });
  it("auto-open only before the wizard was ever opened; checklist until finished", () => {
    const fresh = normalize({ status: "pending" });
    expect(shouldAutoOpen(fresh)).toBe(true);
    expect(showChecklist(fresh)).toBe(true);
    const opened = start(fresh, T);
    expect(opened.status).toBe("started");
    expect(shouldAutoOpen(opened)).toBe(false);
    expect(showChecklist(opened)).toBe(true);
    expect(showChecklist(finish(opened, T2))).toBe(false);
    expect(showChecklist(normalize({}))).toBe(false);
    expect(shouldAutoOpen(normalize({}))).toBe(false);
  });
  it("start is idempotent and never reopens a finished setup", () => {
    const s = start(normalize({ status: "pending" }), T);
    expect(start(s, T2).startedAt).toBe(T);
    const done = finish(s, T2);
    expect(start(done, T2).status).toBe("done");
  });
  it("marking steps: progress, next step, done is not downgraded by a skip", () => {
    let s = start(normalize({ status: "pending" }), T);
    expect(nextStep(s)).toBe("company");
    s = markStep(s, "company", "done", T);
    s = markStep(s, "locations", "skipped", T);
    expect(nextStep(s)).toBe("departments");
    expect(progress(s)).toMatchObject({ done: 1, visited: 2, total: 9 });
    s = markStep(s, "company", "skipped", T2);
    expect(s.steps.company).toEqual({ status: "done", at: T });
    s = markStep(s, "locations", "done", T2);
    expect(s.steps.locations?.status).toBe("done");
    for (const k of STEP_KEYS) s = markStep(s, k, "done", T2);
    expect(nextStep(s)).toBe("invite");
    expect(progress(s).percent).toBe(100);
  });
  it("marking a step on a pending setup starts it", () => {
    const s = markStep(normalize({ status: "pending" }), "company", "done", T);
    expect(s.status).toBe("started");
    expect(s.startedAt).toBe(T);
  });
});

describe("checkCompany", () => {
  it("accepts a minimal company and cleans values", () => {
    const r = checkCompany({ name: "  Acme   Labs  ", pan: "abcde1234f", tan: "", state: "ka", pincode: "560001", city: " Bengaluru " });
    expect(r).toEqual({ ok: true, value: { name: "Acme Labs", pan: "ABCDE1234F", tan: null, address: { city: "Bengaluru", state: "KA", pincode: "560001" } } });
  });
  it("rejects bad PAN, TAN, state and PIN with the field", () => {
    expect(checkCompany({ name: "A" })).toMatchObject({ ok: false, problem: { field: "name" } });
    expect(checkCompany({ name: "Acme", pan: "ABCD1234F" })).toMatchObject({ ok: false, problem: { field: "pan" } });
    expect(checkCompany({ name: "Acme", tan: "ABCDE1234F" })).toMatchObject({ ok: false, problem: { field: "tan" } });
    expect(checkCompany({ name: "Acme", state: "XX" })).toMatchObject({ ok: false, problem: { field: "state" } });
    expect(checkCompany({ name: "Acme", pincode: "012345" })).toMatchObject({ ok: false, problem: { field: "pincode" } });
  });
});

describe("checkLeaveBasics", () => {
  it("accepts numbers or numeric strings, half days", () => {
    expect(checkLeaveBasics({ yearStart: "apr", quotas: { CL: "12", SL: 7.5, EL: 0 } })).toEqual({ ok: true, value: { yearStart: "apr", quotas: { CL: 12, SL: 7.5, EL: 0 } } });
  });
  it("rejects out of range, quarter days, missing values and unknown year starts", () => {
    expect(checkLeaveBasics({ yearStart: "jul", quotas: { CL: 1, SL: 1, EL: 1 } })).toMatchObject({ ok: false, problem: { field: "yearStart" } });
    expect(checkLeaveBasics({ yearStart: "jan", quotas: { CL: 61, SL: 1, EL: 1 } })).toMatchObject({ ok: false, problem: { field: "CL" } });
    expect(checkLeaveBasics({ yearStart: "jan", quotas: { CL: 1, SL: 1.25, EL: 1 } })).toMatchObject({ ok: false, problem: { field: "SL" } });
    expect(checkLeaveBasics({ yearStart: "jan", quotas: { CL: 1, SL: 1 } })).toMatchObject({ ok: false, problem: { field: "EL" } });
    expect(checkLeaveBasics({ yearStart: "jan", quotas: { CL: -1, SL: 1, EL: 1 } })).toMatchObject({ ok: false, problem: { field: "CL" } });
  });
});
