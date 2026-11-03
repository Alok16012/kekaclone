import { describe, expect, it } from "vitest";
import { buildQuery, cell, DATASETS, datasetByKey, describeSchedule, nextRunAt, parseSchedule, reportRange, safeText, toCsv, validateDefinition } from "./rules";

const emp = datasetByKey("employees")!;
const ID = "11111111-1111-4111-8111-111111111111";

describe("datasets", () => {
  it("are all scoped through employees and have unique column keys", () => {
    for (const d of DATASETS) {
      expect(d.from).toMatch(/employees e/);
      expect(new Set(d.columns.map((c) => c.key)).size).toBe(d.columns.length);
      expect(d.columns.some((c) => c.key === d.defaultSort)).toBe(true);
    }
  });
});

describe("definition validation", () => {
  it("drops unknown columns and rejects bad filters", () => {
    const ok = validateDefinition(emp, { columns: ["name", "nope", "department"], filters: [{ col: "status", op: "eq", value: "active" }], sort: { col: "name", dir: "desc" }, limit: 99999 });
    expect(ok).toMatchObject({ ok: true, def: { columns: ["name", "department"], filters: [{ col: "status", op: "eq", value: "active" }], groupBy: null, sort: { col: "name", dir: "desc" }, limit: 5000 } });
    const bad = validateDefinition(emp, { columns: [], filters: [{ col: "joining_date", op: "contains", value: "x" }, { col: "joining_date", op: "gt", value: "yesterday" }, { col: "zzz", op: "eq" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.map((p) => p.field)).toEqual(["columns", "filters.0", "filters.1", "filters.2"]);
  });
  it("normalises values by type", () => {
    const r = validateDefinition(emp, { columns: ["name"], filters: [{ col: "joining_date", op: "between", value: ["2026-01-01", "2026-03-31"] }, { col: "status", op: "in", value: "active, notice" }, { col: "exit_date", op: "is_null" }] });
    expect(r.ok && r.def.filters).toEqual([{ col: "joining_date", op: "between", value: ["2026-01-01", "2026-03-31"] }, { col: "status", op: "in", value: ["active", "notice"] }, { col: "exit_date", op: "is_null", value: null }]);
    const money = validateDefinition(datasetByKey("expense_claims")!, { columns: ["title"], filters: [{ col: "total", op: "gte", value: "1500.50" }] });
    expect(money.ok && money.def.filters[0].value).toBe(150050);
  });
  it("supports group by with aggregates and defaults to count", () => {
    const r = validateDefinition(datasetByKey("time_entries")!, { groupBy: "project", aggregates: [{ fn: "sum", col: "hours" }, { fn: "avg", col: "name" }], sort: { col: "sum_hours", dir: "desc" } });
    expect(r.ok).toBe(false);   // avg over a text column
    const r2 = validateDefinition(datasetByKey("time_entries")!, { groupBy: "project", aggregates: [{ fn: "sum", col: "hours" }], sort: { col: "sum_hours", dir: "desc" } });
    expect(r2.ok && r2.def).toMatchObject({ groupBy: "project", aggregates: [{ fn: "sum", col: "hours" }], sort: { col: "sum_hours", dir: "desc" } });
    const r3 = validateDefinition(emp, { groupBy: "department" });
    expect(r3.ok && r3.def.aggregates).toEqual([{ fn: "count", col: null }]);
  });
});

describe("query building", () => {
  it("only emits whitelisted SQL and parameterises every value", () => {
    const v = validateDefinition(emp, { columns: ["name", "department"], filters: [{ col: "name", op: "contains", value: "a'; drop table employees; --" }, { col: "joining_date", op: "gte", value: "2026-01-01" }], sort: { col: "department", dir: "asc" } });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const q = buildQuery(emp, v.def);
    expect(q.sql).toBe(`select e.display_name as "name", d.name as "department" from ${emp.from} where e.id = any($1::uuid[]) and e.display_name ilike $2 and e.joining_date >= $3::date order by d.name asc nulls last limit 5000`);
    expect(q.params).toEqual(["%a'; drop table employees; --%", "2026-01-01"]);
    expect(q.headers.map((h) => h.key)).toEqual(["name", "department"]);
  });
  it("groups with aggregates", () => {
    const ds = datasetByKey("time_entries")!;
    const v = validateDefinition(ds, { groupBy: "project", aggregates: [{ fn: "sum", col: "hours" }, { fn: "count" }], sort: { col: "sum_hours", dir: "desc" } });
    if (!v.ok) throw new Error("bad");
    const q = buildQuery(ds, v.def);
    expect(q.sql).toContain('group by p.name order by "sum_hours" desc');
    expect(q.headers.map((h) => h.label)).toEqual(["Project", "Total hours", "Rows"]);
  });
  it("handles between and in with casts", () => {
    const v = validateDefinition(emp, { columns: ["name"], filters: [{ col: "joining_date", op: "between", value: ["2026-01-01", "2026-02-01"] }, { col: "status", op: "in", value: ["active"] }] });
    if (!v.ok) throw new Error("bad");
    const q = buildQuery(emp, v.def);
    expect(q.sql).toContain("e.joining_date between $2::date and $3::date and e.status::text = any($4::text[])");
    expect(q.params).toEqual(["2026-01-01", "2026-02-01", ["active"]]);
  });
});

describe("output", () => {
  it("formats cells, escapes CSV and guards formulas", () => {
    expect(cell("money", 150050)).toBe("1500.50");
    expect(cell("bool", true)).toBe("Yes");
    expect(cell("date", new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
    expect(cell("text", null)).toBe("");
    expect(toCsv([["a", 'b "q"'], ["x,y", null]])).toBe('a,"b ""q"""\r\n"x,y",\r\n');
    expect(safeText("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(safeText("plain")).toBe("plain");
  });
  it("defaults the range to this month and caps it at a year", () => {
    expect(reportRange(null, null, "2026-11-03")).toEqual({ from: "2026-11-01", to: "2026-11-03" });
    expect(reportRange("2026-01-01", "2020-01-01", "2026-11-03")).toEqual({ from: "2026-01-01", to: "2026-01-01" });
    expect(reportRange("2024-01-01", "2026-11-03", "2026-11-03").to).toBe("2025-01-01");
  });
});

describe("schedules", () => {
  it("parses and describes", () => {
    expect(parseSchedule({ frequency: "weekly", weekday: 1, hour: 9, recipients: [ID], format: "csv" })).toEqual({ frequency: "weekly", weekday: 1, day: 1, hour: 9, recipients: [ID], format: "csv" });
    expect(parseSchedule({ frequency: "monthly", day: 31, hour: 9, recipients: [ID] })).toBeNull();
    expect(parseSchedule({ frequency: "daily", hour: 25, recipients: [ID] })).toBeNull();
    expect(parseSchedule({ frequency: "daily", hour: 8, recipients: [] })).toBeNull();
    expect(describeSchedule({ frequency: "weekly", weekday: 5, day: 1, hour: 8, recipients: [], format: "xlsx" })).toBe("Every Friday at 08:00 IST");
    expect(describeSchedule({ frequency: "monthly", weekday: 1, day: 3, hour: 18, recipients: [], format: "xlsx" })).toBe("On the 3rd of every month at 18:00 IST");
  });
  it("computes the next run in IST, strictly after now", () => {
    const now = new Date("2026-11-03T04:00:00Z");   // 09:30 IST on a Tuesday
    expect(nextRunAt({ frequency: "daily", weekday: 1, day: 1, hour: 9, recipients: [], format: "csv" }, now).toISOString()).toBe("2026-11-04T03:30:00.000Z");
    expect(nextRunAt({ frequency: "daily", weekday: 1, day: 1, hour: 10, recipients: [], format: "csv" }, now).toISOString()).toBe("2026-11-03T04:30:00.000Z");
    expect(nextRunAt({ frequency: "weekly", weekday: 1, day: 1, hour: 9, recipients: [], format: "csv" }, now).toISOString()).toBe("2026-11-09T03:30:00.000Z");
    expect(nextRunAt({ frequency: "monthly", weekday: 1, day: 1, hour: 9, recipients: [], format: "csv" }, now).toISOString()).toBe("2026-12-01T03:30:00.000Z");
  });
});
