import { describe, expect, it } from "vitest";
import {
  buildForest, canEditField, canViewField, coerceFieldValue, csvCell, delegationActive, displayFieldValue, fieldRoleFor, layoutTree, maskId,
  matchesConditions, normaliseIdNumber, pickWorkflow, probationBucket, slugKey, toCsv, validateLevels, verhoeffValid, daysWaiting,
} from "./rules";
import { idCardToken, verifyIdCardToken } from "./id-token";
import { diffUpdateRows, type Current, type UpdateLookups } from "./bulk-update-rules";

const def = (over: Partial<Parameters<typeof coerceFieldValue>[0]> = {}) => ({ type: "text" as const, options: null, required: false, label: "Field", ...over });

describe("custom field values", () => {
  it("empty is null, or an error when required", () => {
    expect(coerceFieldValue(def(), "")).toEqual({ ok: true, value: null });
    expect(coerceFieldValue(def({ required: true }), " ")).toMatchObject({ ok: false });
  });
  it("numbers, dates (ISO and Indian order) and booleans", () => {
    expect(coerceFieldValue(def({ type: "number" }), "1,250.5")).toEqual({ ok: true, value: 1250.5 });
    expect(coerceFieldValue(def({ type: "number" }), "abc")).toMatchObject({ ok: false });
    expect(coerceFieldValue(def({ type: "date" }), "05-11-2026")).toEqual({ ok: true, value: "2026-11-05" });
    expect(coerceFieldValue(def({ type: "date" }), "2026-02-30")).toMatchObject({ ok: false });
    expect(coerceFieldValue(def({ type: "boolean" }), "Yes")).toEqual({ ok: true, value: true });
    expect(coerceFieldValue(def({ type: "boolean" }), "maybe")).toMatchObject({ ok: false });
  });
  it("select keeps the defined spelling; multi-select splits and de-duplicates", () => {
    expect(coerceFieldValue(def({ type: "select", options: ["Small", "Large"] }), "large")).toEqual({ ok: true, value: "Large" });
    expect(coerceFieldValue(def({ type: "select", options: ["Small"] }), "Huge")).toMatchObject({ ok: false });
    expect(coerceFieldValue(def({ type: "multi_select", options: ["A", "B"] }), "a, b; A")).toEqual({ ok: true, value: ["A", "B"] });
    expect(coerceFieldValue(def({ type: "multi_select", options: ["A"] }), "A, C")).toMatchObject({ ok: false });
  });
  it("email, phone and length limits", () => {
    expect(coerceFieldValue(def({ type: "email" }), "X@Y.IN")).toEqual({ ok: true, value: "x@y.in" });
    expect(coerceFieldValue(def({ type: "phone" }), "+91 98450 12345")).toMatchObject({ ok: true });
    expect(coerceFieldValue(def({ type: "phone" }), "call me")).toMatchObject({ ok: false });
    expect(coerceFieldValue(def(), "x".repeat(201))).toMatchObject({ ok: false });
  });
  it("roles: HR sees and edits all; colleagues nothing; edit implies view", () => {
    const d = { view_roles: ["manager"], edit_roles: ["employee"] };
    expect(fieldRoleFor("colleague")).toBeNull();
    expect(canViewField(d, "employee")).toBe(true);
    expect(canViewField(d, "manager")).toBe(true);
    expect(canEditField(d, "manager")).toBe(false);
    expect(canEditField(d, "hr_admin")).toBe(true);
    expect(canViewField(d, null)).toBe(false);
  });
  it("keys and display", () => {
    expect(slugKey(" T-shirt size! ")).toBe("t_shirt_size");
    expect(slugKey("###")).toBe("field");
    expect(displayFieldValue(["A", "B"])).toBe("A, B");
    expect(displayFieldValue(false)).toBe("No");
  });
});

describe("approval workflows", () => {
  it("conditions: AND across fields, OR within one", () => {
    const c = [{ field: "department" as const, values: ["d1", "d2"] }, { field: "worker_type" as const, values: ["intern"] }];
    expect(matchesConditions(c, { department: "d2", worker_type: "intern" })).toBe(true);
    expect(matchesConditions(c, { department: "d2", worker_type: "permanent" })).toBe(false);
    expect(matchesConditions([], {})).toBe(true);
  });
  it("picks by priority, then the more specific", () => {
    const all = { priority: 0, conditions: [], name: "all" };
    const sales = { priority: 0, conditions: [{ field: "department" as const, values: ["s"] }], name: "sales" };
    const top = { priority: 5, conditions: [{ field: "location" as const, values: ["blr"] }], name: "top" };
    expect(pickWorkflow([all, sales, top], { department: "s", location: "blr" })?.name).toBe("top");
    expect(pickWorkflow([all, sales, top], { department: "s" })?.name).toBe("sales");
    expect(pickWorkflow([all, sales], { department: "x" })?.name).toBe("all");
    expect(pickWorkflow([sales], { department: "x" })).toBeUndefined();
  });
  it("level validation", () => {
    expect(validateLevels([{ approver: "role" }])).toMatch(/role/);
    expect(validateLevels([{ approver: "employee" }])).toMatch(/person/);
    expect(validateLevels(Array(7).fill({ approver: "manager" }))).toMatch(/6/);
    expect(validateLevels([{ approver: "manager" }, { approver: "role", role: "hr_admin" }])).toBeNull();
  });
  it("delegation windows and waiting days", () => {
    expect(delegationActive({ from_date: "2026-11-01", to_date: null }, "2027-01-01")).toBe(true);
    expect(delegationActive({ from_date: "2026-11-01", to_date: "2026-11-03" }, "2026-11-04")).toBe(false);
    expect(delegationActive({ from_date: "2026-11-01", to_date: null, cancelled_at: "x" }, "2026-11-02")).toBe(false);
    expect(daysWaiting(new Date("2026-11-01T10:00:00Z"), new Date("2026-11-03T09:00:00Z"))).toBe(1);
  });
});

describe("identity numbers", () => {
  it("PAN, Aadhaar (Verhoeff), passport, voter ID", () => {
    expect(normaliseIdNumber("pan", "abcde 1234 f")).toEqual({ ok: true, value: "ABCDE1234F" });
    expect(normaliseIdNumber("pan", "ABCDE12345")).toMatchObject({ ok: false });
    expect(verhoeffValid("234123412346")).toBe(true);
    expect(normaliseIdNumber("aadhaar", "2341 2341 2346")).toEqual({ ok: true, value: "234123412346" });
    expect(normaliseIdNumber("aadhaar", "234123412345")).toMatchObject({ ok: false });
    expect(normaliseIdNumber("aadhaar", "123412341234")).toMatchObject({ ok: false });
    expect(normaliseIdNumber("passport", "a1234567")).toEqual({ ok: true, value: "A1234567" });
    expect(normaliseIdNumber("voter_id", "AB1234567")).toMatchObject({ ok: false });
  });
  it("masks to the last four", () => {
    expect(maskId("aadhaar", "2346")).toBe("XXXX XXXX 2346");
    expect(maskId("pan", "234K")).toBe("XXXXXX234K");
    expect(maskId("passport", null)).toBe("••••????");
  });
});

describe("org chart", () => {
  const rows = [
    { id: "a", name: "Asha", title: "CEO", manager_id: null },
    { id: "r", name: "Rohan", title: null, manager_id: "a" },
    { id: "x", name: "Arjun", title: null, manager_id: "r" },
    { id: "m", name: "Meera", title: null, manager_id: "r" },
    { id: "p", name: "Priya", title: null, manager_id: "a" },
    { id: "l1", name: "Loop1", title: null, manager_id: "l2" },
    { id: "l2", name: "Loop2", title: null, manager_id: "l1" },
  ];
  it("builds a sorted forest and survives reporting loops", () => {
    const f = buildForest(rows);
    expect(f.map((n) => n.id)).toEqual(["a", "l1"]);
    expect(f[0].children.map((c) => c.name)).toEqual(["Priya", "Rohan"]);
    expect(buildForest(rows, "r")[0].children.map((c) => c.name)).toEqual(["Arjun", "Meera"]);
    expect(buildForest(rows, "nope")).toEqual([]);
  });
  it("lays leaves left to right with parents centred", () => {
    const L = layoutTree(buildForest(rows.slice(0, 5)), { w: 100, h: 40, gapX: 10, gapY: 20 });
    const at = (id: string) => L.nodes.find((n) => n.id === id)!;
    expect(at("p").x).toBe(0); expect(at("x").x).toBe(110); expect(at("m").x).toBe(220); expect(at("r").x).toBe(165); expect(at("a").x).toBe(82.5);
    expect(at("a").y).toBe(0); expect(at("x").y).toBe(120);
    expect(L.width).toBe(320); expect(L.height).toBe(160);
  });
});

describe("export + probation helpers", () => {
  it("CSV quotes and defuses formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(toCsv([["x", 1], ["y", null]])).toBe("x,1\r\ny,\r\n");
  });
  it("probation buckets", () => {
    expect(probationBucket("2026-11-01", "2026-11-03")).toBe("overdue");
    expect(probationBucket("2026-11-10", "2026-11-03")).toBe("due_soon");
    expect(probationBucket("2027-01-10", "2026-11-03")).toBe("upcoming");
  });
});

describe("ID card token", () => {
  it("binds tenant and person; tampering fails", () => {
    const t = idCardToken("s", "tenant-a", "11111111-1111-1111-1111-111111111111");
    expect(verifyIdCardToken("s", "tenant-a", t)).toBe("11111111-1111-1111-1111-111111111111");
    expect(verifyIdCardToken("s", "tenant-b", t)).toBeNull();
    expect(verifyIdCardToken("other", "tenant-a", t)).toBeNull();
    expect(verifyIdCardToken("s", "tenant-a", t.replace("11111111-1111", "22222222-2222"))).toBeNull();
    expect(verifyIdCardToken("s", "tenant-a", "garbage")).toBeNull();
  });
});

describe("bulk update diff", () => {
  const cur = (o: Partial<Current>): Current => ({ id: "e1", employee_number: "E1", display_name: "Arjun Rao", first_name: "Arjun", last_name: "Rao", mobile: null, personal_email: null, dob: null, gender: null,
    department_id: "d1", designation_id: null, location_id: null, manager_id: "m1", worker_type: "permanent", custom: {}, inScope: true, ...o });
  const lk = (people: Current[]): UpdateLookups => ({
    byNumber: new Map(people.map((p) => [p.employee_number.toLowerCase(), p])), departments: new Map([["engineering", "d1"], ["sales", "d2"]]),
    designations: new Map(), locations: new Map(), employeesByEmail: new Map([["m@x.in", "m1"], ["a@x.in", "e1"], ["b@x.in", "e2"]]),
    customDefs: [{ id: "c", key: "size", label: "Size", section: "S", type: "select", options: ["S", "M"], required: true, view_roles: [], edit_roles: [], position: 0, status: "published" }],
  });
  const names = { departments: new Map([["d1", "Engineering"], ["d2", "Sales"]]), designations: new Map(), locations: new Map(), people: new Map([["m1", "Manager"], ["e1", "Arjun"], ["e2", "Bina"]]) };
  it("blank means unchanged; real changes are listed", () => {
    const r = diffUpdateRows([{ rowNumber: 2, values: { employeeNumber: "e1", mobile: "", department: "Sales", workerType: "Contract" }, custom: { size: "m" } }], lk([cur({})]), names);
    expect(r.valid).toBe(true);
    expect(r.rows[0].changes.map((c) => c.label)).toEqual(["Department", "Worker type", "Size"]);
    expect(r.rows[0].job).toEqual({ department_id: "d2", worker_type: "contract" });
    expect(r.rows[0].custom).toEqual({ size: "M" });
  });
  it("same values: no change; unknown values, missing people and scope are errors", () => {
    expect(diffUpdateRows([{ rowNumber: 2, values: { employeeNumber: "E1", department: "engineering" }, custom: {} }], lk([cur({})]), names).changed).toBe(0);
    const bad = diffUpdateRows([
      { rowNumber: 2, values: { employeeNumber: "E1", department: "Nope", gender: "x" }, custom: {} },
      { rowNumber: 3, values: { employeeNumber: "E9" }, custom: {} },
      { rowNumber: 4, values: { employeeNumber: "E2", mobile: "+91 9" }, custom: {} },
    ], lk([cur({}), cur({ id: "e2", employee_number: "E2", inScope: false })]), names);
    expect(bad.valid).toBe(false);
    expect(bad.rows[0].errors).toHaveLength(2);
    expect(bad.rows[1].errors[0]).toMatch(/No one has/);
    expect(bad.rows[2].errors[0]).toMatch(/outside/);
  });
  it("catches reporting loops made by the file as a whole", () => {
    const r = diffUpdateRows([
      { rowNumber: 2, values: { employeeNumber: "E1", managerEmail: "b@x.in" }, custom: {} },
      { rowNumber: 3, values: { employeeNumber: "E2", managerEmail: "a@x.in" }, custom: {} },
    ], lk([cur({ manager_id: null }), cur({ id: "e2", employee_number: "E2", display_name: "Bina", manager_id: null })]), names);
    expect(r.valid).toBe(false);
    expect(r.rows.some((x) => x.errors.some((e) => /loop/.test(e)))).toBe(true);
  });
});
