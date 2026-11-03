import { describe, expect, it } from "vitest";
import { dailyDue, dedupeKey, describe as describeAutomation, matches, render, validateAutomation, yearsBetween } from "./rules";

describe("render", () => {
  it("fills placeholders and blanks unknown ones", () => {
    expect(render("Hi {{employee.first_name}}, welcome to {{company}}! {{missing}}.", { "employee.first_name": "Asha", company: "Acme" })).toBe("Hi Asha, welcome to Acme! .");
    expect(render("{{ years }} years", { years: 3 })).toBe("3 years");
  });
});

describe("matches", () => {
  const facts = { department_id: "d1", worker_type: "intern", "leave.days": 2.5, "ticket.category": "IT support" };
  it("AND of conditions; empty list always matches", () => {
    expect(matches([], facts)).toBe(true);
    expect(matches([{ field: "department_id", op: "eq", value: "d1" }, { field: "worker_type", op: "neq", value: "permanent" }], facts)).toBe(true);
    expect(matches([{ field: "department_id", op: "eq", value: "d1" }, { field: "worker_type", op: "eq", value: "permanent" }], facts)).toBe(false);
  });
  it("in / not_in / numeric / contains", () => {
    expect(matches([{ field: "department_id", op: "in", value: ["d2", "d1"] }], facts)).toBe(true);
    expect(matches([{ field: "department_id", op: "not_in", value: ["d2", "d1"] }], facts)).toBe(false);
    expect(matches([{ field: "leave.days", op: "gte", value: 2 }], facts)).toBe(true);
    expect(matches([{ field: "leave.days", op: "lte", value: 2 }], facts)).toBe(false);
    expect(matches([{ field: "ticket.category", op: "contains", value: "it" }], facts)).toBe(true);
    expect(matches([{ field: "location_id", op: "eq", value: "x" }], facts)).toBe(false);   // missing fact never equals
  });
});

describe("dailyDue", () => {
  const p = { dob: "1990-03-05", joining_date: "2022-03-05", probation_end_date: "2026-11-10", exit_date: null };
  it("birthday and anniversary on the day only", () => {
    expect(dailyDue("birthday", {}, p, "2026-03-05")).toEqual({ years: 36 });
    expect(dailyDue("birthday", {}, p, "2026-03-06")).toBeNull();
    expect(dailyDue("work_anniversary", {}, p, "2026-03-05")).toEqual({ years: 4 });
    expect(dailyDue("work_anniversary", {}, { ...p, joining_date: "2026-03-05" }, "2026-03-05")).toBeNull();   // joined today, no anniversary yet
  });
  it("29 February birthdays fall on 28 February in other years", () => {
    expect(dailyDue("birthday", {}, { ...p, dob: "1992-02-29" }, "2026-02-28")).not.toBeNull();
    expect(dailyDue("birthday", {}, { ...p, dob: "1992-02-29" }, "2028-02-28")).toBeNull();
    expect(dailyDue("birthday", {}, { ...p, dob: "1992-02-29" }, "2028-02-29")).not.toBeNull();
  });
  it("date offsets: before probation end, after joining, around this year's birthday", () => {
    expect(dailyDue("date_offset", { field: "probation_end_date", offset_days: -7 }, p, "2026-11-03")).not.toBeNull();
    expect(dailyDue("date_offset", { field: "probation_end_date", offset_days: -7 }, p, "2026-11-04")).toBeNull();
    expect(dailyDue("date_offset", { field: "joining_date", offset_days: 30 }, p, "2022-04-04")).not.toBeNull();
    expect(dailyDue("date_offset", { field: "dob", offset_days: -1 }, p, "2026-03-04")).not.toBeNull();
    expect(dailyDue("date_offset", { field: "exit_date", offset_days: -1 }, p, "2026-03-04")).toBeNull();   // no date → never
  });
  it("event triggers are never due on the daily pass", () => {
    expect(dailyDue("employee.joined", {}, p, "2022-03-05")).toBeNull();
  });
});

describe("validateAutomation", () => {
  const good = { name: "Welcome", trigger: "employee.joined", conditions: [{ field: "department_id", op: "in", value: ["d1"] }], actions: [{ type: "notify", to: ["employee", "manager"], title: "Welcome {{employee.first_name}}", body: "" }] };
  it("accepts a well-formed automation and normalises it", () => {
    const r = validateAutomation(good);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.is_active).toBe(true); expect(r.value.actions[0]).toMatchObject({ type: "notify", to: ["employee", "manager"] }); }
  });
  it("rejects missing name, unknown trigger, no actions, bad recipients and bad webhook urls", () => {
    expect(validateAutomation({ ...good, name: " " })).toMatchObject({ ok: false, problem: { field: "name" } });
    expect(validateAutomation({ ...good, trigger: "x" })).toMatchObject({ ok: false, problem: { field: "trigger" } });
    expect(validateAutomation({ ...good, actions: [] })).toMatchObject({ ok: false, problem: { field: "actions" } });
    expect(validateAutomation({ ...good, actions: [{ type: "notify", to: ["nobody"], title: "x" }] })).toMatchObject({ ok: false });
    expect(validateAutomation({ ...good, actions: [{ type: "webhook", url: "http://x" }] })).toMatchObject({ ok: false });
    expect(validateAutomation({ ...good, actions: [{ type: "task", to: "manager", title: "Set up laptop", due_days: 3 }] })).toMatchObject({ ok: true });
    expect(validateAutomation({ ...good, actions: [{ type: "task", to: "manager", title: "Set up laptop", due_days: -1 }] })).toMatchObject({ ok: false });
  });
  it("date_offset needs a field and a bounded offset", () => {
    expect(validateAutomation({ ...good, trigger: "date_offset", trigger_config: {} })).toMatchObject({ ok: false, problem: { field: "trigger_config" } });
    expect(validateAutomation({ ...good, trigger: "date_offset", trigger_config: { field: "probation_end_date", offset_days: 400 } })).toMatchObject({ ok: false });
    const r = validateAutomation({ ...good, trigger: "date_offset", trigger_config: { field: "probation_end_date", offset_days: "-7" } });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.value.trigger_config).toEqual({ field: "probation_end_date", offset_days: -7 });
  });
  it("conditions are typed: enums checked, numbers coerced, lists for in/not_in", () => {
    expect(validateAutomation({ ...good, conditions: [{ field: "worker_type", op: "eq", value: "robot" }] })).toMatchObject({ ok: false });
    const r = validateAutomation({ ...good, conditions: [{ field: "leave.days", op: "gte", value: "2" }, { field: "department_id", op: "in", value: "d1" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.conditions).toEqual([{ field: "leave.days", op: "gte", value: 2 }, { field: "department_id", op: "in", value: ["d1"] }]);
  });
});

describe("misc", () => {
  it("yearsBetween, dedupe keys and descriptions", () => {
    expect(yearsBetween("2020-06-15", "2026-06-14")).toBe(5);
    expect(yearsBetween("2020-06-15", "2026-06-15")).toBe(6);
    expect(dedupeKey("e1", "2026-11-03")).toBe("e1:2026-11-03");
    expect(dedupeKey(null, "evt")).toBe("-:evt");
    expect(describeAutomation({ trigger: "date_offset", trigger_config: { field: "probation_end_date", offset_days: -7 }, conditions: [], actions: [{ type: "notify", to: ["manager"], title: "x", body: "" }, { type: "task", to: "manager", title: "y", due_days: 1 }] }))
      .toBe("Days before or after a date (7 days before probation end date) · notify people, create a task");
  });
});
