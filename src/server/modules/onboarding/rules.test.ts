import { describe, expect, it } from "vitest";
import { allClosed, cleanCriteria, completionAllowed, dueDate, isOverdue, itemConfig, matchScore, offsetLabel, ownerLabel, pickTemplate, progress, validateItem, DEFAULT_ONBOARDING_TASKS, type ItemInput } from "./rules";

const P = { department_id: "d1", location_id: "l1", designation_id: "g1", legal_entity_id: "e1" };

describe("template criteria", () => {
  it("empty criteria match everyone with score 0", () => {
    expect(matchScore({}, P)).toBe(0);
    expect(matchScore({}, { department_id: null, location_id: null, designation_id: null, legal_entity_id: null })).toBe(0);
  });
  it("every listed criterion must match", () => {
    expect(matchScore({ department_ids: ["d1"], location_ids: ["l1"] }, P)).toBe(2);
    expect(matchScore({ department_ids: ["d1"], location_ids: ["l2"] }, P)).toBe(-1);
    expect(matchScore({ designation_ids: ["g1", "g2"] }, P)).toBe(1);
    expect(matchScore({ legal_entity_ids: ["e9"] }, P)).toBe(-1);
  });
  it("a person without a department doesn't match a department template", () => {
    expect(matchScore({ department_ids: ["d1"] }, { ...P, department_id: null })).toBe(-1);
  });
  it("cleans duplicates and empty lists", () => {
    expect(cleanCriteria({ department_ids: ["a", "a", ""], location_ids: [] })).toEqual({ department_ids: ["a"] });
    expect(cleanCriteria(null)).toEqual({});
  });
  it("picks the most specific template, oldest on ties, null when none applies", () => {
    const t = [
      { id: "general", criteria: {}, created_at: "2024-01-01" },
      { id: "eng", criteria: { department_ids: ["d1"] }, created_at: "2024-02-01" },
      { id: "eng-blr", criteria: { department_ids: ["d1"], location_ids: ["l1"] }, created_at: "2024-03-01" },
      { id: "sales", criteria: { department_ids: ["d2"] }, created_at: "2023-01-01" },
    ];
    expect(pickTemplate(t, P)?.id).toBe("eng-blr");
    expect(pickTemplate(t, { ...P, location_id: "l2" })?.id).toBe("eng");
    expect(pickTemplate(t, { ...P, department_id: "d3" })?.id).toBe("general");
    expect(pickTemplate([t[3]], P)).toBeNull();
    const tie = [{ id: "b", criteria: {}, created_at: "2024-05-01" }, { id: "a", criteria: {}, created_at: "2024-01-01" }];
    expect(pickTemplate(tie, P)?.id).toBe("a");
  });
});

describe("due dates and progress", () => {
  it("counts from the joining date", () => {
    expect(dueDate("2026-11-10", -3)).toBe("2026-11-07");
    expect(dueDate("2026-11-10", 0)).toBe("2026-11-10");
    expect(dueDate("2026-12-30", 5)).toBe("2027-01-04");
    expect(offsetLabel(0)).toBe("On the joining day");
    expect(offsetLabel(-1)).toBe("1 day before joining");
    expect(offsetLabel(7)).toBe("7 days after joining");
  });
  it("overdue = open and due before today", () => {
    expect(isOverdue({ status: "open", due_date: "2026-11-01" }, "2026-11-03")).toBe(true);
    expect(isOverdue({ status: "open", due_date: "2026-11-03" }, "2026-11-03")).toBe(false);
    expect(isOverdue({ status: "done", due_date: "2026-11-01" }, "2026-11-03")).toBe(false);
    expect(isOverdue({ status: "open", due_date: null }, "2026-11-03")).toBe(false);
  });
  it("skipped tasks drop out of progress", () => {
    const p = progress([{ status: "done", due_date: null }, { status: "skipped", due_date: null }, { status: "open", due_date: "2026-01-01" }], "2026-11-03");
    expect(p).toEqual({ total: 2, done: 1, overdue: 1, pct: 50 });
    expect(progress([], "2026-11-03").pct).toBe(100);
    expect(allClosed([{ status: "done" }, { status: "skipped" }])).toBe(true);
    expect(allClosed([{ status: "done" }, { status: "open" }])).toBe(false);
  });
});

describe("template items", () => {
  const base: ItemInput = { title: "Laptop", type: "simple", owner: { type: "manager" }, dueOffsetDays: 0 };
  it("accepts the defaults", () => {
    for (const d of DEFAULT_ONBOARDING_TASKS) expect(validateItem(d)).toBeNull();
  });
  it("needs a title, a type, an owner and a sane offset", () => {
    expect(validateItem({ ...base, title: " " })?.field).toBe("title");
    expect(validateItem({ ...base, type: "nope" as never })?.field).toBe("type");
    expect(validateItem({ ...base, dueOffsetDays: 500 })?.field).toBe("dueOffsetDays");
    expect(validateItem({ ...base, dueOffsetDays: 1.5 })?.field).toBe("dueOffsetDays");
    expect(validateItem({ ...base, owner: { type: "role", role: "" } })?.field).toBe("owner");
    expect(validateItem({ ...base, owner: { type: "employee", id: "" } })?.field).toBe("owner");
  });
  it("type-specific settings", () => {
    expect(validateItem({ ...base, type: "profile_field", owner: { type: "self" } })?.field).toBe("field");
    expect(validateItem({ ...base, type: "profile_field", owner: { type: "self" }, config: { field: "mobile" } })).toBeNull();
    expect(validateItem({ ...base, type: "profile_field", owner: { type: "manager" }, config: { field: "mobile" } })?.field).toBe("owner");
    expect(validateItem({ ...base, type: "document_upload", owner: { type: "self" }, config: { docType: "PAN", category: "identity" } })).toBeNull();
    expect(validateItem({ ...base, type: "document_upload", owner: { type: "self" }, config: { docType: "PAN", category: "x" as never } })?.field).toBe("category");
    expect(validateItem({ ...base, type: "approval", owner: { type: "self" } })?.field).toBe("owner");
  });
  it("keeps only the config a type uses", () => {
    expect(itemConfig({ ...base, config: { field: "mobile", docType: "x" } })).toEqual({});
    expect(itemConfig({ ...base, type: "document_upload", config: { docType: "  PAN card ", category: "identity", field: "mobile" } })).toEqual({ docType: "PAN card", category: "identity" });
  });
  it("each type is finished its own way", () => {
    expect(completionAllowed("simple", "done")).toBe(true);
    expect(completionAllowed("simple", "decide")).toBe(false);
    expect(completionAllowed("approval", "done")).toBe(false);
    expect(completionAllowed("approval", "decide")).toBe(true);
    expect(completionAllowed("acknowledge", "acknowledge")).toBe(true);
    expect(completionAllowed("document_upload", "done")).toBe(false);
    expect(completionAllowed("profile_field", "field")).toBe(true);
  });
  it("owner labels", () => {
    expect(ownerLabel({ type: "self" })).toBe("New joiner");
    expect(ownerLabel({ type: "manager" })).toBe("Manager");
    expect(ownerLabel({ type: "role", role: "hr_admin" })).toBe("HR");
  });
});
