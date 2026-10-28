import "server-only";
import ExcelJS from "exceljs";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { can, canFor } from "@/server/auth/permissions";
import { createEmployee } from "./service";
import { IMPORT_COLUMNS, MAX_ROWS, validateImport, type Lookups, type RawRow, type RowResult } from "./import-rules";

const MAX_BYTES = 5 * 1024 * 1024;

async function lookups(tx: Tx): Promise<Lookups & { names: { departments: string[]; designations: string[]; locations: string[] } }> {
  const [deps, dess, locs, emps] = await Promise.all([
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    tx<{ id: string; work_email: string; employee_number: string }[]>`select id, work_email, employee_number from employees`,
  ]);
  const m = (xs: { id: string; name: string }[]) => new Map(xs.map((x) => [x.name.toLowerCase(), x.id]));
  return {
    departments: m(deps), designations: m(dess), locations: m(locs),
    employeesByEmail: new Map(emps.map((e) => [e.work_email.toLowerCase(), e.id])),
    employeeNumbers: new Set(emps.map((e) => e.employee_number.toLowerCase())),
    names: { departments: deps.map((d) => d.name), designations: dess.map((d) => d.name), locations: locs.map((d) => d.name) },
  };
}

/** Template with headers, an example row, dropdowns fed from a "Lists" sheet, and a short how-to. */
export async function buildTemplate(tx: Tx, actor: Actor) {
  if (!can(actor, "employees.write")) throw new AppError("forbidden", "You don't have access to add people.");
  const lk = await lookups(tx);
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet("People", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = IMPORT_COLUMNS.map((c) => ({ header: c.required ? `${c.header} *` : c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0FE" } };
  ws.addRow(Object.fromEntries(IMPORT_COLUMNS.map((c) => [c.key, c.key === "department" ? lk.names.departments[0] ?? "" : c.key === "designation" ? lk.names.designations[0] ?? "" : c.key === "location" ? lk.names.locations[0] ?? "" : c.example])));
  ws.getRow(2).font = { italic: true, color: { argb: "FF6B7480" } };
  ws.getColumn("joiningDate").numFmt = "yyyy-mm-dd";

  const lists = wb.addWorksheet("Lists", { state: "veryHidden" });
  const listCols: [string, string[]][] = [["Department", lk.names.departments], ["Designation", lk.names.designations], ["Location", lk.names.locations], ["Gender", ["Female", "Male", "Non-binary", "Prefer not to say"]]];
  listCols.forEach(([h, vals], i) => { lists.getCell(1, i + 1).value = h; vals.forEach((v, j) => (lists.getCell(j + 2, i + 1).value = v)); });
  const col = (i: number) => String.fromCharCode(65 + i);
  const keyIndex = (k: string) => IMPORT_COLUMNS.findIndex((c) => c.key === k);
  // range-wide validations exist at runtime but aren't in exceljs's typings
  const validations = (ws as unknown as { dataValidations: { add(range: string, dv: ExcelJS.DataValidation): void } }).dataValidations;
  const dropdown = (key: string, listIdx: number, n: number) => {
    if (!n) return;
    const letter = col(keyIndex(key));
    validations.add(`${letter}2:${letter}${MAX_ROWS + 1}`, { type: "list", allowBlank: true, formulae: [`Lists!$${col(listIdx)}$2:$${col(listIdx)}$${n + 1}`], showErrorMessage: true, errorTitle: "Not in the list", error: "Pick a value from the list, or add it in erp Settings first." });
  };
  dropdown("department", 0, lk.names.departments.length);
  dropdown("designation", 1, lk.names.designations.length);
  dropdown("location", 2, lk.names.locations.length);
  dropdown("gender", 3, 4);

  const help = wb.addWorksheet("How to fill");
  help.getColumn(1).width = 110;
  [
    "One person per row on the People sheet. Columns marked * are required. Delete the grey example row or overwrite it.",
    "Joining date: YYYY-MM-DD (2026-11-02) or DD-MM-YYYY (02-11-2026).",
    "Department, Designation and Location must match what's set up in erp Settings (use the dropdowns).",
    "Manager's work email can be someone already in erp, or someone else in this same file.",
    "Employee number is optional; leave it empty and erp generates one.",
    `Up to ${MAX_ROWS} people per file. Nothing is saved until every row is valid.`,
  ].forEach((t, i) => (help.getCell(i + 1, 1).value = t));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Reads the first sheet; finds columns by header text so reordered or extra columns are fine. */
export async function readWorkbook(bytes: ArrayBuffer): Promise<RawRow[]> {
  if (bytes.byteLength > MAX_BYTES) throw new AppError("invalid", "The file is larger than 5 MB.");
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes); } catch { throw new AppError("invalid", "This isn't an Excel (.xlsx) file erp can read. Download the template and fill that in."); }
  const ws = wb.getWorksheet("People") ?? wb.worksheets[0];
  if (!ws) throw new AppError("invalid", "The file has no sheets.");
  const norm = (s: unknown) => String(s ?? "").replace(/\*/g, "").trim().toLowerCase();
  const header = ws.getRow(1);
  const colOf = new Map<string, number>();
  header.eachCell((cell, i) => { const c = IMPORT_COLUMNS.find((x) => x.header.toLowerCase() === norm(cell.value)); if (c) colOf.set(c.key, i); });
  const missing = IMPORT_COLUMNS.filter((c) => c.required && !colOf.has(c.key)).map((c) => c.header);
  if (missing.length) throw new AppError("invalid", `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Use the erp template.`);
  const rows: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    rows.push({ rowNumber: n, values: Object.fromEntries([...colOf].map(([k, i]) => [k, r.getCell(i).value])) });
  });
  // the template's example row is kept out unless someone actually edited it
  const ex = IMPORT_COLUMNS.find((c) => c.key === "workEmail")!.example;
  return rows.filter((r) => String(r.values.workEmail ?? "").trim().toLowerCase() !== ex);
}

export type ImportPreview = { results: RowResult[]; valid: boolean; total: number; ok: number };

async function check(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  if (!can(actor, "employees.write")) throw new AppError("forbidden", "You don't have access to add people.");
  const raw = await readWorkbook(bytes);
  const lk = await lookups(tx);
  const v = validateImport(raw, lk);
  // scoped admins may only add people inside their scope
  const [le] = await tx<{ id: string | null }[]>`select (select id from legal_entities order by created_at limit 1) as id`;
  for (const r of v.results) {
    if (!r.row) continue;
    const place = { department_id: r.row.departmentId, location_id: r.row.locationId, legal_entity_id: le.id, business_unit_id: null };
    if (!canFor(actor, "employees.write", place)) { r.errors.push("You can only add people to departments and locations you manage."); r.row = undefined; }
  }
  const valid = v.valid && v.results.every((r) => !r.errors.length);
  return { ...v, valid };
}

export async function previewImport(tx: Tx, actor: Actor, bytes: ArrayBuffer): Promise<ImportPreview> {
  const v = await check(tx, actor, bytes);
  return { results: v.results.map((r) => ({ rowNumber: r.rowNumber, name: r.name, email: r.email, errors: r.errors })), valid: v.valid, total: v.results.length, ok: v.results.filter((r) => !r.errors.length).length };
}

/** All or nothing: re-validates, then creates everyone in manager-first order inside the caller's transaction. */
export async function commitImport(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  const v = await check(tx, actor, bytes);
  if (!v.valid) throw new AppError("invalid", "Some rows have problems. Fix them and upload the file again.");
  const created = new Map<string, string>();
  for (const r of v.order) {
    const managerId = r.manager?.kind === "existing" ? r.manager.id : r.manager?.kind === "row" ? created.get(r.manager.email) ?? null : null;
    const e = await createEmployee(tx, actor.tenant.id, {
      firstName: r.firstName, lastName: r.lastName, workEmail: r.workEmail, mobile: r.mobile, employeeNumber: r.employeeNumber,
      joiningDate: r.joiningDate, gender: r.gender, departmentId: r.departmentId, designationId: r.designationId, locationId: r.locationId, managerId,
    }, actor.userId);
    created.set(r.workEmail, e.employeeId);
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'employee', 'bulk_import', ${tx.json({ count: created.size })})`;
  return { created: created.size };
}
