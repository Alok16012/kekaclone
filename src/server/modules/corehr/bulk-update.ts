import "server-only";
import ExcelJS from "exceljs";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { applyProfileChanges } from "@/server/modules/employees/effects";
import { changeJob } from "@/server/modules/employees/profile";
import { todayIn } from "@/lib/dates";
import { hasAnyGrant } from "./people";
import { listDefs } from "./custom-fields";
import { canEditField } from "./rules";
import { MAX_UPDATE_ROWS, UPDATE_COLUMNS, diffUpdateRows, type Current, type UpdateKey, type UpdateRaw } from "./bulk-update-rules";

const MAX_BYTES = 5 * 1024 * 1024;
const assertAny = (actor: Actor) => { if (!hasAnyGrant(actor, "employees.write")) throw new AppError("forbidden", "You don't have access to update people."); };

async function lookups(tx: Tx, actor: Actor) {
  const [people, deps, dess, locs, defs] = await Promise.all([
    tx<(Omit<Current, "inScope"> & Placement & { work_email: string; status: string })[]>`
      select id, employee_number, display_name, first_name, last_name, mobile, personal_email, dob::text, gender, department_id, designation_id, location_id, manager_id,
        worker_type, custom, legal_entity_id, business_unit_id, work_email, status from employees where status <> 'relieved' order by display_name`,
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    listDefs(tx, { published: true }),
  ]);
  const byNumber = new Map(people.map((p) => [p.employee_number.toLowerCase(), { ...p, inScope: p.id !== actor.employeeId && canFor(actor, "employees.write", p) } as Current]));
  const m = (xs: { id: string; name: string }[]) => new Map(xs.map((x) => [x.name.toLowerCase(), x.id]));
  const n = (xs: { id: string; name: string }[]) => new Map(xs.map((x) => [x.id, x.name]));
  return {
    people, deps, dess, locs,
    lk: { byNumber, departments: m(deps), designations: m(dess), locations: m(locs), employeesByEmail: new Map(people.map((p) => [p.work_email.toLowerCase(), p.id])), customDefs: defs.filter((d) => canEditField(d, "hr_admin")) },
    names: { departments: n(deps), designations: n(dess), locations: n(locs), people: new Map(people.map((p) => [p.id, p.display_name])) },
  };
}

/** Today's values for everyone the actor manages, ready to edit. Blank cells are left alone on upload. */
export async function buildUpdateTemplate(tx: Tx, actor: Actor) {
  assertAny(actor);
  const { people, deps, dess, locs, lk, names } = await lookups(tx, actor);
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet("People", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const customCols = lk.customDefs.map((d) => ({ header: d.label, key: `custom:${d.key}`, width: Math.max(14, d.label.length + 4) }));
  ws.columns = [...UPDATE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width })), ...customCols];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0FE" } };
  const emailOf = new Map(people.map((p) => [p.id, p.work_email]));
  const label = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1).replace("_", "-") : "");
  for (const p of people) {
    if (!lk.byNumber.get(p.employee_number.toLowerCase())!.inScope) continue;
    ws.addRow({
      employeeNumber: p.employee_number, name: p.display_name, firstName: p.first_name, lastName: p.last_name ?? "", mobile: p.mobile ?? "", personalEmail: p.personal_email ?? "",
      dob: p.dob ?? "", gender: p.gender === "undisclosed" ? "Prefer not to say" : label(p.gender), department: p.department_id ? names.departments.get(p.department_id) : "",
      designation: p.designation_id ? names.designations.get(p.designation_id) : "", location: p.location_id ? names.locations.get(p.location_id) : "",
      managerEmail: p.manager_id ? emailOf.get(p.manager_id) ?? "" : "", workerType: label(p.worker_type),
      ...Object.fromEntries(lk.customDefs.map((d) => { const v = p.custom?.[d.key]; return [`custom:${d.key}`, Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : v ?? ""]; })),
    });
  }
  ws.getColumn("employeeNumber").font = { bold: true };
  ws.getColumn("name").font = { color: { argb: "FF6B7480" } };
  const lists = wb.addWorksheet("Lists", { state: "veryHidden" });
  [["Department", deps.map((d) => d.name)], ["Designation", dess.map((d) => d.name)], ["Location", locs.map((d) => d.name)], ["Worker type", ["Permanent", "Contract", "Intern", "Consultant"]], ["Gender", ["Female", "Male", "Non-binary", "Prefer not to say"]]]
    .forEach(([h, vals], i) => { lists.getCell(1, i + 1).value = h as string; (vals as string[]).forEach((v, j) => (lists.getCell(j + 2, i + 1).value = v)); });
  const validations = (ws as unknown as { dataValidations: { add(range: string, dv: ExcelJS.DataValidation): void } }).dataValidations;
  const col = (key: UpdateKey) => String.fromCharCode(65 + UPDATE_COLUMNS.findIndex((c) => c.key === key));
  const dropdown = (key: UpdateKey, listIdx: number, n: number) => { if (n) validations.add(`${col(key)}2:${col(key)}${MAX_UPDATE_ROWS + 1}`, { type: "list", allowBlank: true, formulae: [`Lists!$${String.fromCharCode(65 + listIdx)}$2:$${String.fromCharCode(65 + listIdx)}$${n + 1}`] }); };
  dropdown("department", 0, deps.length); dropdown("designation", 1, dess.length); dropdown("location", 2, locs.length); dropdown("workerType", 3, 4); dropdown("gender", 4, 4);
  const help = wb.addWorksheet("How to fill");
  help.getColumn(1).width = 110;
  [
    "Each row is one existing person, found by Employee number. Change only the cells you want to update.",
    "An empty cell means: leave this as it is. (Clearing a value isn't possible from the file; do that on the profile.)",
    "Department, Designation and Location must match what's set up in erp Settings (use the dropdowns).",
    "Job changes (department, designation, location, manager, worker type) take effect today and show in each person's job history.",
    `Up to ${MAX_UPDATE_ROWS} people per file. Nothing is saved until every row is valid.`,
  ].forEach((t, i) => (help.getCell(i + 1, 1).value = t));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function readUpdateWorkbook(bytes: ArrayBuffer, defs: { key: string; label: string }[]): Promise<UpdateRaw[]> {
  if (bytes.byteLength > MAX_BYTES) throw new AppError("invalid", "The file is larger than 5 MB.");
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes); } catch { throw new AppError("invalid", "This isn't an Excel (.xlsx) file erp can read. Download the update template and edit that."); }
  const ws = wb.getWorksheet("People") ?? wb.worksheets[0];
  if (!ws) throw new AppError("invalid", "The file has no sheets.");
  const norm = (s: unknown) => String(s ?? "").replace(/\*/g, "").trim().toLowerCase();
  const colOf = new Map<string, number>(), customOf = new Map<string, number>();
  ws.getRow(1).eachCell((cell, i) => {
    const h = norm(cell.value);
    const c = UPDATE_COLUMNS.find((x) => x.header.toLowerCase() === h);
    if (c) colOf.set(c.key, i);
    const d = defs.find((x) => x.label.toLowerCase() === h);
    if (d) customOf.set(d.key, i);
  });
  if (!colOf.has("employeeNumber")) throw new AppError("invalid", "The file needs an “Employee number” column. Use the erp update template.");
  const rows: UpdateRaw[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    rows.push({ rowNumber: n, values: Object.fromEntries([...colOf].filter(([k]) => k !== "name").map(([k, i]) => [k, r.getCell(i).value])), custom: Object.fromEntries([...customOf].map(([k, i]) => [k, r.getCell(i).value])) });
  });
  return rows;
}

async function check(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  assertAny(actor);
  const { lk, names } = await lookups(tx, actor);
  const raw = await readUpdateWorkbook(bytes, lk.customDefs);
  // the file has to match today's data: rows that change nothing are ignored, so re-uploading is a no-op
  return diffUpdateRows(raw, lk, names);
}

export async function previewUpdate(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  const v = await check(tx, actor, bytes);
  return { valid: v.valid, changed: v.changed, total: v.rows.length, rows: v.rows.map((r) => ({ rowNumber: r.rowNumber, name: r.name, errors: r.errors, changes: r.changes })) };
}

/** All or nothing. Personal fields are written directly, job fields go through dated job changes (today). */
export async function commitUpdate(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  const v = await check(tx, actor, bytes);
  if (!v.valid) throw new AppError("invalid", "Some rows have problems. Fix them and upload the file again.");
  const today = todayIn();
  let updated = 0;
  for (const r of v.rows) {
    if (!r.changes.length || !r.employeeId) continue;
    if (Object.keys(r.profile).length) {
      const changes = { ...r.profile };
      if ("first_name" in changes || "last_name" in changes) {
        const [cur] = await tx<{ first_name: string; last_name: string | null }[]>`select first_name, last_name from employees where id = ${r.employeeId}`;
        changes.display_name = [String(changes.first_name ?? cur.first_name), (changes.last_name ?? cur.last_name) as string | null].filter(Boolean).join(" ");
      }
      await applyProfileChanges(tx, actor.tenant.id, r.employeeId, changes, actor.userId);
    }
    if (Object.keys(r.job).length) {
      const kind = r.job.department_id || r.job.location_id ? "transfer" : r.job.designation_id ? "designation_change" : r.job.manager_id ? "manager_change" : "other";
      await changeJob(tx, actor, r.employeeId, { kind, effectiveDate: today, changes: r.job, note: "Bulk update from Excel" });
    }
    if (Object.keys(r.custom).length) {
      const [cur] = await tx<{ custom: Record<string, unknown> }[]>`select custom from employees where id = ${r.employeeId}`;
      const next = { ...(cur.custom ?? {}), ...r.custom };
      for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
      await tx`update employees set custom = ${tx.json(next as never)} where id = ${r.employeeId}`;
      await audit(tx, actor, { entityType: "employee", entityId: r.employeeId, action: "custom_fields.update", diff: r.custom });
    }
    updated++;
  }
  await audit(tx, actor, { entityType: "employee", action: "bulk_update", diff: { count: updated } });
  return { updated };
}
