import "server-only";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import { assign, canAssignSomeone, listAssignments, listCapture, listPenalties, listShifts, listWeeklyOffs, type AssignInput } from "./policies";
import { listOvertimePolicies } from "./overtime";

/**
 * Shift / weekly-off / clock-in / penalty / overtime assignments from Excel: one row per person with the columns to change
 * (blank = leave as it is) and an effective date. Dated kinds (shift, weekly off) start on that date; the others apply
 * at once. Rows are grouped and handed to the same `assign` the screen uses, so scopes, overlap rules and
 * re-processing behave exactly as there. Nothing is saved unless every row is valid.
 */

const HEADERS = ["Employee number", "Name", "Shift code", "Weekly off policy", "Clock-in rules", "Penalty policy", "Overtime policy", "Effective from"] as const;
const MAX_BYTES = 5 * 1024 * 1024, MAX_ROWS = 2000;
const NONE = new Set(["none", "no", "-", "remove", "clear"]);

export async function buildAssignmentTemplate(tx: Tx, actor: Actor) {
  if (!canAssignSomeone(actor)) throw new AppError("forbidden", "You don't have access to time assignments.");
  const today = todayIn();
  const [rows, shifts, offs, caps, pens, ots] = [await listAssignments(tx, actor, today), await listShifts(tx, today), await listWeeklyOffs(tx, today), await listCapture(tx), await listPenalties(tx), await listOvertimePolicies(tx)];
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet("Assignments", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Employee number *", width: 18 }, { header: "Name", width: 28 }, { header: "Shift code", width: 12 }, { header: "Weekly off policy", width: 24 },
    { header: "Clock-in rules", width: 26 }, { header: "Penalty policy", width: 22 }, { header: "Overtime policy", width: 22 }, { header: "Effective from *", width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0FE" } };
  const shiftCode = (name: string | null) => shifts.find((s) => s.name === name)?.code ?? "";
  for (const r of rows) ws.addRow([r.number, r.name, shiftCode(r.shift), r.weekly_off ?? "", r.capture?.replace(/ \(default\)$/, "") ?? "", r.penalty ?? "", r.overtime ?? "", today]);
  ws.getColumn(8).numFmt = "@";
  const lists = wb.addWorksheet("Options");
  lists.columns = [{ header: "Shift codes", width: 30 }, { header: "Weekly off policies", width: 30 }, { header: "Clock-in rules", width: 30 }, { header: "Penalty policies", width: 30 }, { header: "Overtime policies", width: 30 }];
  lists.getRow(1).font = { bold: true };
  const cols = [shifts.map((s) => `${s.code} = ${s.name}`), offs.map((o) => o.name), caps.map((c) => c.name), ["none", ...pens.map((p) => p.name)], ["none", ...ots.map((p) => p.name)]];
  for (let i = 0; i < Math.max(...cols.map((c) => c.length)); i++) lists.addRow(cols.map((c) => c[i] ?? ""));
  const help = wb.addWorksheet("How to fill");
  help.getColumn(1).width = 110;
  [
    "One row per person. The file comes pre-filled with what applies to everyone today; change only the columns you want to change and leave the rest as they are.",
    "A blank cell means no change. Write none in Penalty policy or Overtime policy to remove one.",
    "Shift code is the short code (see the Options sheet); the other policy columns take the policy's name.",
    "Effective from (YYYY-MM-DD) is when the new shift or weekly off starts: the current one ends the day before, anything planned after that date is replaced. Clock-in, penalty and overtime changes apply at once.",
    "erp matches people by employee number and checks every row before saving anything.",
  ].forEach((s, i) => (help.getCell(i + 1, 1).value = s));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

type Change = { kind: AssignInput["kind"]; policyId: string | null; label: string };
export type AssignmentImportRow = { rowNumber: number; employee: string; name: string | null; from: string | null; changes: { kind: string; label: string }[]; errors: string[] };
export type AssignmentImportPreview = { valid: boolean; total: number; people: number; changes: number; results: AssignmentImportRow[] };

const toDate = (v: unknown): string | null => {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T00:00:00Z").toISOString().startsWith(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) { const d = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; return new Date(d + "T00:00:00Z").toISOString().startsWith(d) ? d : null; }
  return null;
};

async function check(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  if (!canAssignSomeone(actor)) throw new AppError("forbidden", "You don't have access to time assignments.");
  if (bytes.byteLength > MAX_BYTES) throw new AppError("invalid", "The file is larger than 5 MB.");
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes); } catch { throw new AppError("invalid", "This isn't an Excel (.xlsx) file erp can read. Download the template and fill that in."); }
  const ws = wb.getWorksheet("Assignments") ?? wb.worksheets[0];
  if (!ws) throw new AppError("invalid", "The file has no sheets.");
  const norm = (s: unknown) => String((s as { text?: string })?.text ?? s ?? "").replace(/\*/g, "").trim().toLowerCase();
  const col = new Map<string, number>();
  ws.getRow(1).eachCell((c, i) => { const h = HEADERS.find((x) => x.toLowerCase() === norm(c.value)); if (h) col.set(h, i); });
  const missing = ["Employee number", "Effective from"].filter((h) => !col.has(h));
  if (missing.length) throw new AppError("invalid", `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Use the erp template.`);
  type Raw = { rowNumber: number; employee: string; shift: string; off: string; capture: string; penalty: string; overtime: string; from: unknown };
  const raw: Raw[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const cell = (h: string) => { const i = col.get(h); if (!i) return null; const v = r.getCell(i).value; return (v as { result?: unknown })?.result ?? (v as { text?: string })?.text ?? v; };
    const str = (h: string) => String(cell(h) ?? "").trim();
    raw.push({ rowNumber: n, employee: str("Employee number"), shift: str("Shift code"), off: str("Weekly off policy"), capture: str("Clock-in rules"), penalty: str("Penalty policy"), overtime: str("Overtime policy"), from: cell("Effective from") });
  });
  if (!raw.length) throw new AppError("invalid", "The file has no rows to import.");
  if (raw.length > MAX_ROWS) throw new AppError("invalid", `Up to ${MAX_ROWS} rows per file.`);
  const today = todayIn();
  const [people, shifts, offs, caps, pens, ots, current] = [
    await tx<(Placement & { id: string; number: string; name: string })[]>`select id, employee_number as number, display_name as name, department_id, location_id, legal_entity_id, business_unit_id from employees where status <> 'relieved'`,
    await listShifts(tx, today), await listWeeklyOffs(tx, today), await listCapture(tx), await listPenalties(tx), await listOvertimePolicies(tx), await listAssignments(tx, actor, today),
  ];
  const byName = <T extends { id: string; name: string }>(xs: T[], v: string) => xs.find((x) => x.name.toLowerCase() === v.toLowerCase());
  const seen = new Set<string>();
  const results: (AssignmentImportRow & { employeeId?: string; plan: Change[] })[] = raw.map((r) => {
    const errors: string[] = [];
    const plan: Change[] = [];
    const emp = people.find((e) => e.number.toLowerCase() === r.employee.toLowerCase());
    const cur = emp && current.find((c) => c.id === emp.id);
    if (!r.employee) errors.push("Employee number is empty.");
    else if (!emp) errors.push(`No one has employee number ${r.employee}.`);
    else if (!canFor(actor, "attendance.admin", emp)) errors.push(`You can't change time settings for ${emp.name}.`);
    else if (seen.has(emp.id)) errors.push("This person appears on an earlier row too.");
    if (emp) seen.add(emp.id);
    const from = toDate(r.from);
    if (!from) errors.push("Effective from must be a date, like 2026-11-03.");
    else if (from < addDaysISO(today, -31) || from > addDaysISO(today, 366)) errors.push("The effective date can be up to a month back or a year ahead.");
    if (r.shift) {
      const s = shifts.find((x) => x.code.toLowerCase() === r.shift.toLowerCase());
      if (!s) errors.push(`Unknown shift code ${r.shift}.`);
      else if (!cur || cur.shift !== s.name || (cur.next_shift && cur.next_shift_from && from && cur.next_shift_from >= from)) plan.push({ kind: "shift", policyId: s.id, label: `Shift → ${s.name}` });
    }
    if (r.off) {
      const o = byName(offs, r.off);
      if (!o) errors.push(`Unknown weekly off policy ${r.off}.`);
      else if (!cur || cur.weekly_off !== o.name || (cur.next_weekly_off && cur.next_weekly_off_from && from && cur.next_weekly_off_from >= from)) plan.push({ kind: "weekly_off", policyId: o.id, label: `Weekly off → ${o.name}` });
    }
    if (r.capture) {
      const c = byName(caps, r.capture);
      if (!c) errors.push(`Unknown clock-in rules ${r.capture}.`);
      else if (!cur || cur.capture?.replace(/ \(default\)$/, "") !== c.name) plan.push({ kind: "capture", policyId: c.id, label: `Clock-in rules → ${c.name}` });
    }
    if (r.penalty) {
      if (NONE.has(r.penalty.toLowerCase())) { if (cur?.penalty) plan.push({ kind: "penalty", policyId: null, label: "Penalty policy → none" }); }
      else { const p = byName(pens, r.penalty); if (!p) errors.push(`Unknown penalty policy ${r.penalty}.`); else if (cur?.penalty !== p.name) plan.push({ kind: "penalty", policyId: p.id, label: `Penalty policy → ${p.name}` }); }
    }
    if (r.overtime) {
      if (NONE.has(r.overtime.toLowerCase())) { if (cur?.overtime) plan.push({ kind: "overtime", policyId: null, label: "Overtime policy → none" }); }
      else { const p = byName(ots, r.overtime); if (!p) errors.push(`Unknown overtime policy ${r.overtime}.`); else if (cur?.overtime !== p.name) plan.push({ kind: "overtime", policyId: p.id, label: `Overtime policy → ${p.name}` }); }
    }
    if (!errors.length && !r.shift && !r.off && !r.capture && !r.penalty && !r.overtime) errors.push("Nothing to change on this row: fill at least one policy column.");
    return { rowNumber: r.rowNumber, employee: r.employee, name: emp?.name ?? null, from, changes: plan.map((p) => ({ kind: p.kind, label: p.label })), errors, employeeId: emp?.id, plan };
  });
  return { results, valid: results.every((r) => !r.errors.length) };
}

export async function previewAssignmentImport(tx: Tx, actor: Actor, bytes: ArrayBuffer): Promise<AssignmentImportPreview> {
  const { results, valid } = await check(tx, actor, bytes);
  const changed = results.filter((r) => !r.errors.length && r.changes.length);
  return { valid, total: results.length, people: changed.length, changes: changed.reduce((n, r) => n + r.changes.length, 0),
    results: results.map(({ rowNumber, employee, name, from, changes, errors }) => ({ rowNumber, employee, name, from, changes, errors })) };
}

/** All or nothing: rows grouped by (kind, policy, date) go through the same bulk assignment as the screen. */
export async function commitAssignmentImport(tx: Tx, actor: Actor, bytes: ArrayBuffer) {
  const { results, valid } = await check(tx, actor, bytes);
  if (!valid) throw new AppError("invalid", "Some rows have problems. Fix them and upload the file again.");
  const groups = new Map<string, { kind: AssignInput["kind"]; policyId: string | null; from: ISODate; ids: string[] }>();
  for (const r of results) for (const c of r.plan) {
    const k = `${c.kind}|${c.policyId ?? ""}|${r.from}`;
    const g = groups.get(k) ?? { kind: c.kind, policyId: c.policyId, from: r.from!, ids: [] };
    g.ids.push(r.employeeId!);
    groups.set(k, g);
  }
  let updated = 0;
  for (const g of groups.values()) { const r = await assign(tx, actor, { employeeIds: g.ids, kind: g.kind, policyId: g.policyId, from: g.from }); updated += r.updated; }
  const batch = randomUUID();
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'attendance_assignment', null, 'assign.import', ${tx.json({ batch, rows: results.length, groups: groups.size, updated })})`;
  return { rows: results.length, people: new Set(results.filter((r) => r.plan.length).map((r) => r.employeeId)).size, changes: updated };
}
