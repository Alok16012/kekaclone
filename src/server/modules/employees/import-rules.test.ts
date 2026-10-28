import { describe, expect, it } from "vitest";
import { parseDate, validateImport, type Lookups, type RawRow } from "./import-rules";

const lk: Lookups = {
  departments: new Map([["engineering", "d-eng"]]),
  designations: new Map([["software engineer", "t-swe"]]),
  locations: new Map([["head office", "l-ho"]]),
  employeesByEmail: new Map([["asha@acme.test", "e-asha"]]),
  employeeNumbers: new Set(["emp-0001"]),
};
let n = 2;
const row = (v: Record<string, unknown>): RawRow => ({ rowNumber: n++, values: { firstName: "Neha", workEmail: `neha${n}@acme.test`, joiningDate: "2026-11-02", ...v } });

describe("parseDate", () => {
  it("accepts ISO, Indian order and real dates", () => {
    expect(parseDate("2026-11-02")).toBe("2026-11-02");
    expect(parseDate("02-11-2026")).toBe("2026-11-02");
    expect(parseDate("2/11/2026")).toBe("2026-11-02");
    expect(parseDate(new Date(Date.UTC(2026, 10, 2)))).toBe("2026-11-02");
  });
  it("rejects impossible dates and US order that overflows", () => {
    expect(parseDate("31-02-2026")).toBeNull();
    expect(parseDate("11/31/2026")).toBeNull();
    expect(parseDate("next monday")).toBeNull();
  });
});

describe("validateImport", () => {
  it("accepts a clean row and resolves names case-insensitively", () => {
    const r = validateImport([row({ department: "ENGINEERING", designation: "software engineer", location: "Head Office", managerEmail: "Asha@acme.test", gender: "f" })], lk);
    expect(r.valid).toBe(true);
    expect(r.order[0]).toMatchObject({ departmentId: "d-eng", designationId: "t-swe", locationId: "l-ho", gender: "female", manager: { kind: "existing", id: "e-asha" } });
  });
  it("skips blank lines", () => expect(validateImport([row({}), { rowNumber: 99, values: { firstName: "  " } }], lk).results).toHaveLength(1));
  it("reports every problem on a row", () => {
    const r = validateImport([row({ firstName: "", workEmail: "not-an-email", joiningDate: "soon", department: "Marketing", gender: "x" })], lk);
    expect(r.valid).toBe(false);
    expect(r.results[0].errors).toHaveLength(5);
  });
  it("catches duplicates against the company and inside the file", () => {
    const r = validateImport([row({ workEmail: "asha@acme.test" }), row({ workEmail: "dup@acme.test" }), row({ workEmail: "dup@acme.test" }), row({ employeeNumber: "EMP-0001" })], lk);
    expect(r.results.map((x) => x.errors.length)).toEqual([1, 1, 1, 1]);
  });
  it("orders managers from the file before their reports", () => {
    const r = validateImport([row({ workEmail: "dev@acme.test", managerEmail: "lead@acme.test" }), row({ workEmail: "lead@acme.test", managerEmail: "asha@acme.test" })], lk);
    expect(r.valid).toBe(true);
    expect(r.order.map((x) => x.workEmail)).toEqual(["lead@acme.test", "dev@acme.test"]);
  });
  it("refuses reporting loops and unknown managers", () => {
    const loop = validateImport([row({ workEmail: "a@acme.test", managerEmail: "b@acme.test" }), row({ workEmail: "b@acme.test", managerEmail: "a@acme.test" })], lk);
    expect(loop.valid).toBe(false);
    expect(loop.results.some((x) => x.errors.some((e) => e.includes("Reporting loop")))).toBe(true);
    expect(validateImport([row({ managerEmail: "ghost@acme.test" })], lk).results[0].errors[0]).toMatch(/isn't in your company/);
  });
  it("an empty file is not valid", () => expect(validateImport([], lk).valid).toBe(false));
});
