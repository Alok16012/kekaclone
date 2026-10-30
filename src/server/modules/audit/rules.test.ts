import { describe as group, expect, it } from "vitest";
import { changedFields, cleanFilters, decodeCursor, describe, diffLines, encodeCursor, fieldLabel, showValue } from "./rules";

group("describe", () => {
  it("people", () => {
    expect(describe({ entity_type: "employee", action: "create", diff: null, entity_label: "Arjun Rao" })).toBe("added Arjun Rao");
    expect(describe({ entity_type: "employee", action: "update", diff: { mobile: "98", dob: "1990-01-01" }, entity_label: "Arjun Rao" })).toBe("updated Arjun Rao’s profile (mobile, date of birth)");
    expect(describe({ entity_type: "employee", action: "job_change", diff: { before: { manager_id: null }, after: { manager_id: "x" } }, entity_label: "Meera" })).toBe("changed Meera’s job details (manager)");
    expect(describe({ entity_type: "employee", action: "bulk_import", diff: { count: 1 } })).toBe("imported 1 person from a spreadsheet");
    expect(describe({ entity_type: "employee", action: "bulk_import", diff: { count: 4 } })).toBe("imported 4 people from a spreadsheet");
    expect(describe({ entity_type: "employee", action: "probation", diff: { action: "extend", until: "2026-12-01" }, entity_label: "Karan" })).toBe("extended Karan’s probation to 2026-12-01");
    expect(describe({ entity_type: "employee", action: "job_change_scheduled", diff: { effectiveDate: "2026-12-01", changes: { department_id: { old: null, new: "x" } } }, entity_label: "Karan" }))
      .toBe("scheduled a job change for Karan from 2026-12-01 (department)");
  });
  it("long field lists are shortened", () => {
    expect(describe({ entity_type: "employee", action: "update", diff: { a: 1, b: 2, c: 3, d: 4, e: 5 }, entity_label: "X" })).toBe("updated X’s profile (a, b, c and 2 more)");
  });
  it("masters", () => {
    expect(describe({ entity_type: "departments", action: "create", diff: { name: "Design" } })).toBe("added the department “Design”");
    expect(describe({ entity_type: "locations", action: "update", diff: { name: { old: "HQ", new: "Head office" } }, entity_label: "Head office" })).toBe("renamed the location “HQ” to “Head office”");
    expect(describe({ entity_type: "locations", action: "update", diff: { state_code: { old: null, new: "KA" } }, entity_label: "Head office" })).toBe("updated the location “Head office” (state)");
    expect(describe({ entity_type: "bands", action: "delete", diff: { name: "L1" } })).toBe("deleted the band “L1”");
  });
  it("roles, approvals, security, setup", () => {
    expect(describe({ entity_type: "role", action: "assign", diff: { employeeId: "x", scopes: [{ type: "department", ids: ["a"] }] }, entity_label: "HR admin", subject_label: "Priya" }))
      .toBe("gave Priya the role “HR admin” for part of the company");
    expect(describe({ entity_type: "role", action: "unassign", diff: { employeeId: "x" }, entity_label: "HR admin", subject_label: "Priya" })).toBe("removed the role “HR admin” from Priya");
    expect(describe({ entity_type: "role", action: "save", diff: { name: "Ops", permissions: ["a"] }, entity_label: "Ops" })).toBe("saved the role “Ops” with 1 permission");
    expect(describe({ entity_type: "leave", action: "approval.approved", diff: {}, entity_label: "Meera Iyer" })).toBe("approved Meera Iyer’s leave request");
    expect(describe({ entity_type: "profile_change", action: "approval.rejected", diff: {} })).toBe("declined a profile change request");
    expect(describe({ entity_type: "tenant", action: "security.mfa", diff: { mode: "required" } })).toBe("set sign-in codes to Required for everyone");
    expect(describe({ entity_type: "user", action: "security.my_mfa", diff: { on: false } })).toBe("turned off sign-in codes for their account");
    expect(describe({ entity_type: "tenant", action: "setup.step", diff: { step: "leave", status: "skipped" } })).toBe("skipped the setup step “Leave basics”");
    expect(describe({ entity_type: "user", action: "invite", diff: { count: 2 } })).toBe("sent 2 invites");
  });
  it("never blank for unknown actions", () => {
    expect(describe({ entity_type: "widget", action: "frobnicate.now", diff: null })).toBe("frobnicate now · widget");
  });
});

group("diffLines", () => {
  it("old/new pairs", () => {
    expect(diffLines({ name: { old: "A", new: "B" } })).toEqual([{ field: "name", label: "name", before: "A", after: "B" }]);
  });
  it("before/after objects, with extra keys as values", () => {
    expect(diffLines({ before: { manager_id: null }, after: { manager_id: "m" }, note: "promo" })).toEqual([
      { field: "manager_id", label: "manager", before: null, after: "m" },
      { field: "note", label: "note", value: "promo" },
    ]);
  });
  it("changes map and plain values", () => {
    expect(diffLines({ changes: { pan: { old: null, new: "ABCDE1234F" } }, count: 3 })).toEqual([
      { field: "pan", label: "PAN", before: null, after: "ABCDE1234F" },
      { field: "count", label: "count", value: 3 },
    ]);
    expect(diffLines(null)).toEqual([]);
    expect(diffLines([1, 2])).toEqual([]);
  });
  it("changedFields ignores bookkeeping keys", () => {
    expect(changedFields({ name: "x", note: "y", mobile: "1" })).toEqual(["mobile"]);
  });
});

group("cursor", () => {
  it("round-trips with microseconds", () => {
    const c = { at: "2026-10-30T10:11:12.123456Z", id: "0b0f4c4e-8a64-4c2c-9f7a-1f7c3d0e6a11" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
  it("rejects junk", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not-base64-!!")).toBeNull();
    expect(decodeCursor(Buffer.from("2026-10-30T10:11:12Z|1; drop table").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("x|y|z").toString("base64url"))).toBeNull();
  });
});

group("cleanFilters", () => {
  it("drops invalid values and swaps reversed ranges", () => {
    expect(cleanFilters({ actor: "nope", entity: "employee", action: "approval.approved", from: "2026-10-30", to: "2026-10-01" }))
      .toEqual({ actor: null, entity: "employee", action: "approval.approved", from: "2026-10-01", to: "2026-10-30" });
    expect(cleanFilters({ entity: "x; drop", from: "30/10/2026", to: ["2026-10-01", "x"] })).toEqual({ actor: null, entity: null, action: null, from: null, to: "2026-10-01" });
  });
});

group("labels", () => {
  it("fieldLabel and showValue", () => {
    expect(fieldLabel("l2_manager_id")).toBe("second-level manager");
    expect(fieldLabel("emergencyContact")).toBe("emergency contact");
    expect(fieldLabel("blood_group")).toBe("blood group");
    expect(showValue(null)).toBe("—");
    expect(showValue(true)).toBe("Yes");
    expect(showValue({ a: 1 })).toBe('{"a":1}');
  });
});

group("self actions", () => {
  it("says 'their' when the actor is the subject", () => {
    expect(describe({ entity_type: "profile_change", action: "submit", diff: { section: "personal", changes: { blood_group: {} } }, entity_label: "Arjun Rao", actor_label: "Arjun Rao" }))
      .toBe("asked HR to approve changes to their profile (blood group)");
    expect(describe({ entity_type: "leave", action: "cancel", diff: null, entity_label: "Arjun Rao", actor_label: "Asha" })).toBe("cancelled Arjun Rao’s leave request");
  });
});
