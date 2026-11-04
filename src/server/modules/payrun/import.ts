import "server-only";
import ExcelJS from "exceljs";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { cellToPaise } from "@/server/modules/payroll/rules";
import { assertNotSelf, assertRunPayroll } from "./access";
import { bumpVersion, getRun } from "./engine";
import { cellToUnits, IMPORT_HEADERS, IMPORT_KINDS, importKey, kindFromCell, rowProblems, type ImportRow } from "./import-rules";
import { isUnitWorker, monthLabel } from "./rules";

const MAX_BYTES = 5 * 1024 * 1024, MAX_ROWS = 5000;
const OPEN = ["draft", "in_progress"];

/** Template for a run: everyone in the pay group, one empty row each, plus a sheet of instructions. */
export async function buildInputTemplate(tx: Tx, actor: Actor, runId: string) {
  assertRunPayroll(actor);
  const run = await getRun(tx, runId);
  const people = await tx<{ number: string; name: string; worker_type: string }[]>`
    select employee_number as number, display_name as name, worker_type from employees where pay_group_id = ${run.pay_group_id} and status <> 'preboarding' and status <> 'relieved' order by employee_number`;
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet("Inputs", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = IMPORT_HEADERS.map((h) => ({ header: ["Employee number", "Kind"].includes(h) ? `${h} *` : h, width: h === "Name" || h === "Note" ? 28 : 18 }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF0FE" } };
  for (const p of people) ws.addRow([p.number, p.name, isUnitWorker(p.worker_type) ? "Payable units (daily wage / piece rate)" : "", null, null, "", ""]);
  ws.getColumn(4).numFmt = "#,##0.00";
  const help = wb.addWorksheet("How to fill");
  help.getColumn(1).width = 120;
  [
    `Inputs for ${run.pay_group}, ${monthLabel(run.period_month)}. One row per payment, deduction or units entry; a person may have several rows. Delete rows you don't need.`,
    `Kind: one of ${IMPORT_KINDS.map((k) => k.label).join(", ")}.`,
    "Amount: rupees, e.g. 5000 or 5000.50 (bonus, one-time payment or deduction, arrears, overtime, shift allowance, leave encashment).",
    "Days or units: days to encash for leave encashment (basic ÷ 30 per day), or units worked for daily-wage and piece-rate workers (rate × units).",
    "Note: shown on the payslip line. Component code: optional, the code of a salary component to book the amount against (e.g. BONUS).",
    "erp checks every row before saving anything. Uploading the same file twice adds nothing a second time. You can't add inputs for yourself.",
  ].forEach((t, i) => (help.getCell(i + 1, 1).value = t));
  return { bytes: Buffer.from(await wb.xlsx.writeBuffer()), name: `payroll-inputs-${run.period_month.slice(0, 7)}.xlsx` };
}

export type ImportPreviewRow = ImportRow & { name: string | null; kindLabel: string | null; existing: boolean; errors: string[] };

async function check(tx: Tx, actor: Actor, runId: string, bytes: ArrayBuffer) {
  assertRunPayroll(actor);
  const run = await getRun(tx, runId);
  if (!OPEN.includes(run.status)) throw new AppError("conflict", "This run is finalised, so inputs can't be imported into it.");
  if (bytes.byteLength > MAX_BYTES) throw new AppError("invalid", "The file is larger than 5 MB.");
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes); } catch { throw new AppError("invalid", "This isn't an Excel (.xlsx) file erp can read. Download the template and fill that in."); }
  const ws = wb.getWorksheet("Inputs") ?? wb.worksheets[0];
  if (!ws) throw new AppError("invalid", "The file has no sheets.");
  const norm = (v: unknown) => String((v as { text?: string })?.text ?? v ?? "").replace(/\*/g, "").trim().toLowerCase();
  const col = new Map<string, number>();
  ws.getRow(1).eachCell((c, i) => { const h = IMPORT_HEADERS.find((x) => x.toLowerCase() === norm(c.value)); if (h) col.set(h, i); });
  for (const h of ["Employee number", "Kind"]) if (!col.has(h)) throw new AppError("invalid", `Missing column: ${h}. Use the erp template.`);
  const raw: ImportRow[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const cell = (h: string) => { if (!col.has(h)) return null; const v = r.getCell(col.get(h)!).value; return (v as { result?: unknown })?.result ?? v; };
    const kindCell = cell("Kind"), amount = cell("Amount"), days = cell("Days or units");
    if ((kindCell == null || kindCell === "") && (amount == null || amount === "") && (days == null || days === "")) return;   // untouched template row
    raw.push({ rowNumber: n, employee: String(cell("Employee number") ?? "").trim(), kind: kindFromCell(kindCell), amountPaise: cellToPaise(amount), days: cellToUnits(days),
      note: String(cell("Note") ?? "").trim() || null, component: String(cell("Component code") ?? "").trim().toUpperCase() || null });
  });
  if (!raw.length) throw new AppError("invalid", "No rows have a kind, amount or units, so there's nothing to import.");
  if (raw.length > MAX_ROWS) throw new AppError("invalid", `Up to ${MAX_ROWS} rows per file.`);
  const people = await tx<{ id: string; number: string; name: string; worker_type: string; pay_group_id: string | null }[]>`
    select id, employee_number as number, display_name as name, worker_type, pay_group_id from employees where status <> 'relieved'`;
  const comps = await tx<{ id: string; code: string; kind: string }[]>`select id, code, kind from salary_components`;
  const results: (ImportPreviewRow & { employeeId?: string; componentId?: string | null; key?: string })[] = [];
  for (const r of raw) {
    const errors = rowProblems(r, { unitWorker: null });
    const who = people.find((p) => p.number.toLowerCase() === r.employee.toLowerCase());
    if (r.employee && !who) errors.push(`No one has employee number ${r.employee}.`);
    else if (who && who.pay_group_id !== run.pay_group_id) errors.push(`${who.name} isn't in ${run.pay_group}.`);
    else if (who && who.id === actor.employeeId) errors.push("You can't add inputs for yourself. Ask another payroll admin.");
    if (who && r.kind === "payable_units" && !isUnitWorker(who.worker_type)) errors.push(`${who.name} isn't a daily-wage or piece-rate worker.`);
    let componentId: string | null = null;
    if (r.component) {
      const c = comps.find((x) => x.code === r.component);
      if (!c) errors.push(`No salary component has the code ${r.component}.`);
      else if (c.kind === "employer_contribution") errors.push(`${r.component} is an employer contribution, which can't be an input.`);
      else componentId = c.id;
    }
    const key = who && r.kind ? importKey({ payGroupId: run.pay_group_id, month: run.period_month, employeeId: who.id, kind: r.kind, amountPaise: r.amountPaise, days: r.days, note: r.note, componentId }) : undefined;
    if (who && r.kind === "payable_units") {
      // one units entry per person and month: an existing one (unless it is this very row from an earlier upload) must be edited in the run
      const [u] = await tx<{ ref: Record<string, unknown> | null }[]>`select source_ref as ref from payroll_inputs where pay_group_id = ${run.pay_group_id} and period_month = ${run.period_month} and employee_id = ${who.id} and kind = 'payable_units'`;
      if (u && u.ref?.import_key !== key) errors.push(`${who.name} already has payable units for the month. Edit that entry in the run.`);
      if (raw.filter((x) => x.kind === "payable_units" && x.employee.toLowerCase() === r.employee.toLowerCase()).length > 1) errors.push("Payable units appear more than once for this person.");
    }
    const [existing] = key ? await tx<{ id: string }[]>`select id from payroll_inputs where source_ref->>'import_key' = ${key}` : [];
    results.push({ ...r, name: who?.name ?? null, kindLabel: IMPORT_KINDS.find((k) => k.kind === r.kind)?.label ?? null, existing: !!existing, errors, employeeId: who?.id, componentId, key });
  }
  return { run, results, valid: results.every((r) => !r.errors.length) };
}

const strip = (r: ImportPreviewRow & { employeeId?: string; componentId?: string | null; key?: string }): ImportPreviewRow =>
  ({ rowNumber: r.rowNumber, employee: r.employee, kind: r.kind, amountPaise: r.amountPaise, days: r.days, note: r.note, component: r.component, name: r.name, kindLabel: r.kindLabel, existing: r.existing, errors: r.errors });

export async function previewInputImport(tx: Tx, actor: Actor, runId: string, bytes: ArrayBuffer) {
  const { results, valid } = await check(tx, actor, runId, bytes);
  return { valid, total: results.length, toAdd: results.filter((r) => !r.errors.length && !r.existing).length, alreadyAdded: results.filter((r) => r.existing).length, results: results.map(strip) };
}

/** All or nothing. Rows already imported (same person, kind, amount, days, note, component) are skipped, so re-uploading is safe. */
export async function commitInputImport(tx: Tx, actor: Actor, runId: string, bytes: ArrayBuffer, expected?: number | null) {
  const { run, results, valid } = await check(tx, actor, runId, bytes);
  if (!valid) throw new AppError("invalid", "Some rows have problems. Fix them and upload the file again.");
  if (expected != null && expected !== run.lock_version) throw new AppError("conflict", "Someone else changed this run since you opened it. Reload the page to see their changes.");
  let added = 0;
  for (const r of results) {
    if (r.existing) continue;
    assertNotSelf(actor, r.employeeId!, "add payroll inputs for yourself");
    const takesDays = r.kind === "payable_units" || (r.kind === "leave_encashment" && !r.amountPaise);
    const inserted = await tx`
      insert into payroll_inputs (tenant_id, pay_group_id, period_month, employee_id, kind, component_id, amount_paise, days, source_ref, note, created_by)
      values (${actor.tenant.id}, ${run.pay_group_id}, ${run.period_month}, ${r.employeeId!}, ${r.kind!}, ${r.componentId ?? null}, ${takesDays && r.kind === "payable_units" ? null : r.amountPaise},
        ${r.kind === "payable_units" || r.kind === "leave_encashment" ? r.days : null}, ${tx.json({ import_key: r.key!, import_row: r.rowNumber })}, ${r.note}, ${actor.userId})
      on conflict ((source_ref->>'import_key')) where source_ref ? 'import_key' do nothing`;
    added += inserted.count;
  }
  if (added) await bumpVersion(tx, runId, null);
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.inputs_imported", diff: { rows: results.length, added, skipped: results.length - added } });
  return { added, rows: results.length, skipped: results.length - added };
}
