import "server-only";
import ExcelJS from "exceljs";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { todayIn } from "@/lib/dates";
import { canPayrollFor, hasAnyPayrollAdmin } from "./access";
import { arrearsFromMonth, cellToISODate, cellToPaise, computeBreakup, REVISION_REASONS } from "./rules";
import { getActiveSalary, saveSalary } from "./salary";
import { listStructures, toDef } from "./setup";

const HEADERS = ["Employee number", "Name", "Current annual CTC", "New annual CTC", "Effective from", "Reason", "Structure"] as const;
const REQUIRED = ["Employee number", "New annual CTC", "Effective from"];
const MAX_BYTES = 5 * 1024 * 1024, MAX_ROWS = 5000;

type Person = Placement & { id: string; number: string; name: string; pay_group_id: string | null; status: string; joining_date: string };

async function myPeople(tx: Tx, actor: Actor) {
  const all = await tx<Person[]>`
    select id, employee_number as number, display_name as name, pay_group_id, status, joining_date::text,
      department_id, location_id, legal_entity_id, business_unit_id
    from employees where status <> 'relieved' order by display_name`;
  return all.filter((p) => canPayrollFor(actor, p));
}

/** Template pre-filled with the people the admin manages and their CTC today. */
export async function buildRevisionTemplate(tx: Tx, actor: Actor) {
  if (!hasAnyPayrollAdmin(actor)) throw new AppError("forbidden", "You don't have access to salaries.");
  const today = todayIn();
  const people = await myPeople(tx, actor);
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet("Revisions", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = HEADERS.map((h) => ({ header: REQUIRED.includes(h) ? `${h} *` : h, width: h === "Name" || h === "Structure" ? 28 : 20 }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0FE" } };
  for (const p of people) {
    if (p.id === actor.employeeId) continue;
    const s = await getActiveSalary(tx, p.id, today);
    ws.addRow([p.number, p.name, s ? s.ctcPaise / 100 : null, null, null, "revision", s?.structureName ?? null]);
  }
  ws.getColumn(3).numFmt = ws.getColumn(4).numFmt = "#,##0.00";
  const help = wb.addWorksheet("How to fill");
  help.getColumn(1).width = 110;
  [
    "One row per person whose salary changes. Delete the rows of people who aren't getting a revision (or leave New annual CTC empty).",
    "New annual CTC: the yearly amount in rupees, e.g. 1200000. Effective from: the date it starts, as a date or YYYY-MM-DD.",
    "Reason: revision, promotion or correction (revision if empty). Structure: the name of a salary structure in the person's pay group; leave empty to keep their current one.",
    "erp checks every row before saving anything. A date in a month that's already been paid is saved with arrears for payroll to settle.",
    "Uploading the same file twice changes nothing. You can't revise your own salary.",
  ].forEach((s, i) => (help.getCell(i + 1, 1).value = s));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export type RevisionRow = {
  rowNumber: number; employee: string; name: string | null; currentPaise: number | null; newPaise: number | null; effectiveFrom: string | null;
  reason: string; structure: string | null; arrearsFromMonth: string | null; unchanged: boolean; errors: string[];
};

async function check(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  if (!hasAnyPayrollAdmin(actor)) throw new AppError("forbidden", "You don't have access to salaries.");
  if (bytes.byteLength > MAX_BYTES) throw new AppError("invalid", "The file is larger than 5 MB.");
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes); } catch { throw new AppError("invalid", "This isn't an Excel (.xlsx) file erp can read. Download the template and fill that in."); }
  const ws = wb.getWorksheet("Revisions") ?? wb.worksheets[0];
  if (!ws) throw new AppError("invalid", "The file has no sheets.");
  const norm = (s: unknown) => String((s as { text?: string })?.text ?? s ?? "").replace(/\*/g, "").trim().toLowerCase();
  const col = new Map<string, number>();
  ws.getRow(1).eachCell((c, i) => { const h = HEADERS.find((x) => x.toLowerCase() === norm(c.value)); if (h) col.set(h, i); });
  const missing = REQUIRED.filter((h) => !col.has(h));
  if (missing.length) throw new AppError("invalid", `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Use the erp template.`);
  const raw: { rowNumber: number; employee: string; ctc: unknown; date: unknown; reason: string; structure: string }[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const cell = (h: string) => { if (!col.has(h)) return null; const v = r.getCell(col.get(h)!).value; return (v as { result?: unknown })?.result ?? v; };
    const ctc = cell("New annual CTC");
    if (ctc == null || ctc === "") return;   // rows without a new CTC are skipped (the template lists everyone)
    raw.push({ rowNumber: n, employee: String(cell("Employee number") ?? "").trim(), ctc, date: cell("Effective from"),
      reason: String(cell("Reason") ?? "").trim().toLowerCase(), structure: String(cell("Structure") ?? "").trim() });
  });
  if (!raw.length) throw new AppError("invalid", "No rows have a new annual CTC, so there's nothing to import.");
  if (raw.length > MAX_ROWS) throw new AppError("invalid", `Up to ${MAX_ROWS} rows per file.`);

  const today = todayIn();
  const [allPeople, mine, structures] = await Promise.all([
    tx<{ id: string; number: string; name: string }[]>`select id, employee_number as number, display_name as name from employees where status <> 'relieved'`,
    myPeople(tx, actor), listStructures(tx),
  ]);
  const locked = new Map<string, string[]>();
  const seen = new Set<string>();
  const results: (RevisionRow & { employeeId?: string; structureId?: string })[] = [];
  for (const r of raw) {
    const errors: string[] = [];
    const any = allPeople.find((e) => e.number.toLowerCase() === r.employee.toLowerCase());
    const emp = any && mine.find((m) => m.id === any.id);
    const newPaise = cellToPaise(r.ctc);
    const date = cellToISODate(r.date);
    const reason = r.reason || "revision";
    if (!r.employee) errors.push("Employee number is empty.");
    else if (!any) errors.push(`No one has employee number ${r.employee}.`);
    else if (!emp) errors.push(`You don't manage payroll for ${any.name}.`);
    else if (emp.id === actor.employeeId) errors.push("You can't revise your own salary. Ask another payroll admin.");
    if (newPaise == null || newPaise <= 0) errors.push("New annual CTC must be an amount in rupees, like 1200000.");
    if (!date) errors.push("Effective from must be a date, like 2026-04-01.");
    else if (emp && date < emp.joining_date) errors.push(`${emp.name} joined on ${emp.joining_date}; the salary can't start earlier.`);
    if (!(REVISION_REASONS as readonly string[]).includes(reason)) errors.push("Reason must be revision, promotion or correction.");
    const current = emp ? await getActiveSalary(tx, emp.id, today) : null;
    let structure = r.structure ? structures.filter((s) => s.name.toLowerCase() === r.structure.toLowerCase() && (!emp?.pay_group_id || s.pay_group_id === emp.pay_group_id)) : [];
    if (!r.structure && emp) {
      structure = current ? structures.filter((s) => s.id === current.structureId) : structures.filter((s) => s.pay_group_id === emp.pay_group_id);
      if (structure.length !== 1) errors.push(current ? "Their current structure no longer exists. Name one in the Structure column." : "They don't have a salary yet. Name a structure in the Structure column.");
    } else if (r.structure && structure.length !== 1) errors.push(structure.length ? `More than one structure is called ${r.structure}; put them in a pay group first.` : `No structure called ${r.structure}${emp?.pay_group_id ? " in their pay group" : ""}.`);
    const st = structure.length === 1 ? structure[0] : undefined;
    let arrears: string | null = null, unchanged = false;
    if (st && newPaise && newPaise > 0) {
      const b = computeBreakup(toDef(st.lines), newPaise);
      if (!b.ok) errors.push(b.errors[0].message);
    }
    if (emp && date) {
      const k = `${emp.id}|${date}`;
      if (seen.has(k)) errors.push("This person and date appear on an earlier row too.");
      seen.add(k);
      const [same] = await tx<{ ctc_paise: bigint; structure_id: string }[]>`select ctc_paise, structure_id from employee_salaries where employee_id = ${emp.id} and effective_from = ${date}`;
      if (same) {
        if (Number(same.ctc_paise) === newPaise && same.structure_id === st?.id) unchanged = true;
        else errors.push("A different salary already starts on this date. Delete it on their profile first, or use another date.");
      }
      if (st) {
        if (!locked.has(st.pay_group_id)) locked.set(st.pay_group_id, (await tx<{ m: string }[]>`select period_month::text as m from payroll_runs where pay_group_id = ${st.pay_group_id} and status in ('finalized','payslips_released','paid')`).map((x) => x.m));
        arrears = arrearsFromMonth(date, today, locked.get(st.pay_group_id));
      }
    }
    results.push({ rowNumber: r.rowNumber, employee: r.employee, name: any?.name ?? null, currentPaise: current?.ctcPaise ?? null, newPaise, effectiveFrom: date, reason,
      structure: st?.name ?? (r.structure || null), arrearsFromMonth: unchanged ? null : arrears, unchanged, errors, employeeId: emp?.id, structureId: st?.id });
  }
  return { results, valid: results.every((r) => !r.errors.length) };
}

const strip = (r: RevisionRow & { employeeId?: string; structureId?: string }): RevisionRow => ({ rowNumber: r.rowNumber, employee: r.employee, name: r.name, currentPaise: r.currentPaise, newPaise: r.newPaise, effectiveFrom: r.effectiveFrom, reason: r.reason, structure: r.structure, arrearsFromMonth: r.arrearsFromMonth, unchanged: r.unchanged, errors: r.errors });

export async function previewRevisionImport(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  const { results, valid } = await check(tx, actor, bytes);
  return { valid, total: results.length, changes: results.filter((r) => !r.errors.length && !r.unchanged).length, results: results.map(strip) };
}

/** All or nothing. Rows already recorded (same person, date, CTC and structure) are skipped, so re-uploading is safe. */
export async function commitRevisionImport(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  const { results, valid } = await check(tx, actor, bytes);
  if (!valid) throw new AppError("invalid", "Some rows have problems. Fix them and upload the file again.");
  let changed = 0;
  for (const r of results) {
    if (r.unchanged) continue;
    const s = await saveSalary(tx, actor, { employeeId: r.employeeId, structureId: r.structureId, ctcPaise: r.newPaise, effectiveFrom: r.effectiveFrom, reason: r.reason });
    if (!s.unchanged) changed++;
  }
  await audit(tx, actor, { entityType: "employee_salary", entityId: null, action: "salary.import", diff: { rows: results.length, changed } });
  return { changed, rows: results.length };
}

/** Latest salary changes across the people the admin manages, for the revisions screen. */
export async function recentRevisions(tx: Tx, actor: Actor, limit = 50) {
  const ids = (await myPeople(tx, actor)).map((p) => p.id);
  return tx<{ id: string; employee_id: string; name: string; number: string; ctc_paise: bigint; effective_from: string; reason: string; arrears_from_month: string | null; structure: string; created_at: Date; by: string | null }[]>`
    select s.id, s.employee_id, e.display_name as name, e.employee_number as number, s.ctc_paise, s.effective_from::text, s.reason, s.arrears_from_month::text,
      st.name as structure, s.created_at, (select display_name from employees b where b.user_id = s.created_by) as by
    from employee_salaries s join employees e on e.id = s.employee_id join salary_structures st on st.id = s.structure_id
    where s.employee_id = any(${ids}::uuid[]) order by s.created_at desc limit ${limit}`;
}
