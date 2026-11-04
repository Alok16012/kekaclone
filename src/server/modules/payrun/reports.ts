import "server-only";
import ExcelJS from "exceljs";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { assertRunPayroll } from "./access";
import { getRun } from "./engine";
import { csv, ecrLine, LINE_ACTION_LABEL, monthEnd, monthLabel, rupees, slipped, type LineAction, type PayItem, type StatutoryDetail } from "./rules";
import { journalLines, journalTotals, tallyJournalXml, zohoJournalCsv } from "./accounting";

const N = (v: bigint | number | null | undefined) => (v == null ? 0 : Number(v));
type Line = {
  employee_id: string; number: string; name: string; department: string | null; designation: string | null; uan: string | null; esi_number: string | null;
  period_days: string; payable_days: string; lop_days: string; action: LineAction; earnings: PayItem[]; deductions: PayItem[]; employer: PayItem[];
  statutory: StatutoryDetail; gross_paise: bigint; total_deductions_paise: bigint; net_paise: bigint;
};

async function lines(tx: Tx, actor: Actor, runId: string) {
  assertRunPayroll(actor);
  const run = await getRun(tx, runId);
  const rows = await tx<Line[]>`
    select l.employee_id, e.employee_number as number, e.display_name as name, dp.name as department, d.title as designation, st.uan, st.esi_number,
      l.period_days::text, l.payable_days::text, l.lop_days::text, l.action, l.earnings, l.deductions, l.employer, l.statutory, l.gross_paise, l.total_deductions_paise, l.net_paise
    from payroll_lines l join employees e on e.id = l.employee_id left join departments dp on dp.id = e.department_id left join designations d on d.id = e.designation_id
    left join employee_statutory st on st.employee_id = e.id
    where l.run_id = ${runId} order by e.employee_number`;
  return { run, rows };
}
const sumCode = (xs: PayItem[], code: string) => (xs ?? []).filter((x) => x.code === code).reduce((t, x) => t + x.paise, 0);

/** The payroll register: one row per person, one column per earning / deduction / employer contribution. */
export async function registerXlsx(tx: Tx, actor: Actor, runId: string) {
  const { run, rows } = await lines(tx, actor, runId);
  const cols = (pick: (l: Line) => PayItem[]) => {
    const seen = new Map<string, string>();
    for (const l of rows) for (const x of pick(l) ?? []) if (!seen.has(x.code)) seen.set(x.code, x.label.replace(/ \(.*\)$/, ""));
    return [...seen];
  };
  const ec = cols((l) => l.earnings), dc = cols((l) => l.deductions), xc = cols((l) => l.employer);
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet(`Register ${run.period_month.slice(0, 7)}`);
  ws.addRow([`${run.pay_group} · ${monthLabel(run.period_month)} · ${run.status}`]);
  ws.addRow(["Statutory amounts use rates that a CA has not verified unless your company has recorded a verification."]);
  const header = ["Employee number", "Name", "Department", "Designation", "Pay action", "Days in period", "Days paid", "LOP days",
    ...ec.map(([, l]) => l), "Gross earnings", ...dc.map(([, l]) => l), "Total deductions", "Net pay", ...xc.map(([, l]) => `Employer: ${l}`), "Cost to company"];
  const h = ws.addRow(header);
  h.font = { bold: true };
  const money = (p: number) => p / 100;
  for (const l of rows) {
    const employer = (l.employer ?? []).reduce((t, x) => t + x.paise, 0);
    ws.addRow([l.number, l.name, l.department ?? "", l.designation ?? "", LINE_ACTION_LABEL[l.action], Number(l.period_days), Number(l.payable_days), Number(l.lop_days),
      ...ec.map(([c]) => money(sumCode(l.earnings, c))), money(N(l.gross_paise)), ...dc.map(([c]) => money(sumCode(l.deductions, c))), money(N(l.total_deductions_paise)),
      money(N(l.net_paise)), ...xc.map(([c]) => money(sumCode(l.employer, c))), money(N(l.gross_paise) + employer)]);
  }
  const total = (f: (l: Line) => number) => money(rows.reduce((t, l) => t + f(l), 0));
  const t = ws.addRow(["Total", "", "", "", "", "", "", "", ...ec.map(([c]) => total((l) => sumCode(l.earnings, c))), total((l) => N(l.gross_paise)),
    ...dc.map(([c]) => total((l) => sumCode(l.deductions, c))), total((l) => N(l.total_deductions_paise)), total((l) => N(l.net_paise)),
    ...xc.map(([c]) => total((l) => sumCode(l.employer, c))), total((l) => N(l.gross_paise) + (l.employer ?? []).reduce((s, x) => s + x.paise, 0))]);
  t.font = { bold: true };
  for (let i = 9; i <= header.length; i++) ws.getColumn(i).numFmt = "#,##,##0.00";
  ws.columns.forEach((c, i) => { c.width = i < 2 ? 22 : 14; });
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 3 }];
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.report", diff: { kind: "register" } });
  return { bytes: new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer), name: `payroll-register-${run.period_month.slice(0, 7)}.xlsx` };
}

/** PF electronic challan-cum-return text (one member per line). Only people with PF this month and a UAN. */
export async function pfEcr(tx: Tx, actor: Actor, runId: string) {
  const { run, rows } = await lines(tx, actor, runId);
  const out: string[] = [], missing: string[] = [];
  for (const l of rows) {
    const p = l.statutory?.pf;
    if (!slipped(l.action) || !p?.enabled || !p.employeePaise) continue;
    if (!l.uan) { missing.push(l.name); continue; }
    out.push(ecrLine({ uan: l.uan, name: l.name, grossPaise: N(l.gross_paise), epfWagePaise: p.wagePaise, epsWagePaise: p.epsWagePaise, edliWagePaise: p.edliWagePaise,
      employeePaise: p.employeePaise, epsPaise: p.epsPaise, epfPaise: p.epfPaise, ncpDays: Number(l.lop_days) }));
  }
  if (!out.length) throw new AppError("invalid", missing.length ? `Nobody with PF this month has a UAN (${missing.join(", ")}).` : "Nobody has PF deducted in this run.");
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.report", diff: { kind: "pf_ecr", members: out.length, missing } });
  return { text: out.join("\n") + "\n", name: `pf-ecr-${run.period_month.slice(0, 7)}.txt`, missing };
}

/** ESI contribution upload (CSV): IP number, name, days paid, wages, contributions. */
export async function esiFile(tx: Tx, actor: Actor, runId: string) {
  const { run, rows } = await lines(tx, actor, runId);
  const body = rows.filter((l) => slipped(l.action) && l.statutory?.esi?.covered).map((l) => {
    const e = l.statutory.esi!;
    return [l.esi_number ?? "", l.name, Math.round(Number(l.payable_days)), rupees(e.wagePaise), rupees(e.employeePaise), rupees(e.employerPaise), Number(l.payable_days) === 0 ? "1" : "", l.esi_number ? "" : "No ESI number on file"];
  });
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.report", diff: { kind: "esi", members: body.length } });
  return { text: csv([["IP number", "IP name", "Days paid", "Total wages", "Employee contribution", "Employer contribution", "Reason code (0 days)", "Note"], ...body]), name: `esi-${run.period_month.slice(0, 7)}.csv` };
}

/** Professional tax by state: people, gross and PT. */
export async function ptSummary(tx: Tx, actor: Actor, runId: string) {
  const { run, rows } = await lines(tx, actor, runId);
  const by = new Map<string, { people: number; gross: number; pt: number }>();
  for (const l of rows) {
    if (!slipped(l.action)) continue;
    const s = l.statutory?.pt?.state ?? "No state";
    const r = by.get(s) ?? { people: 0, gross: 0, pt: 0 };
    r.people++; r.gross += l.statutory?.pt?.grossPaise ?? 0; r.pt += sumCode(l.deductions, "PT");
    by.set(s, r);
  }
  const summary = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([state, r]) => ({ state, ...r }));
  return { summary, text: csv([["State", "People", "PT gross (INR)", "Professional tax (INR)"], ...summary.map((r) => [r.state, r.people, rupees(r.gross), rupees(r.pt)])]), name: `pt-${run.period_month.slice(0, 7)}.csv` };
}

/**
 * Journal summary: salary cost by component (debits) against what is owed to people, the government and others
 * (credits). Debits equal credits. Account names are suggestions; map them to your chart of accounts.
 */
export async function journal(tx: Tx, actor: Actor, runId: string) {
  const { run, rows } = await lines(tx, actor, runId);
  const dr = new Map<string, number>(), cr = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => { if (v) m.set(k, (m.get(k) ?? 0) + v); };
  for (const l of rows.filter((x) => slipped(x.action))) {
    for (const e of l.earnings ?? []) add(dr, e.kind === "reimbursement" ? `Reimbursements: ${e.label.replace(/ \(.*\)$/, "")}` : `Salary: ${e.label.replace(/ \(.*\)$/, "").replace(/^(Arrears|Loss of pay[^:]*): /, "")}`, e.paise);
    for (const x of l.employer ?? []) { add(dr, `Employer contribution: ${x.label}`, x.paise); add(cr, `Payable: ${x.label.replace(/ \(employer share\)/, "")}`, x.paise); }
    for (const d of l.deductions ?? []) add(cr, d.kind === "statutory" ? `Payable: ${d.label}` : `Recovered: ${d.label}`, d.paise);
    add(cr, "Net salaries payable", N(l.net_paise));
  }
  const toRows = (m: Map<string, number>) => [...m].sort(([a], [b]) => a.localeCompare(b)).map(([account, paise]) => ({ account, paise }));
  const debits = toRows(dr), credits = toRows(cr);
  const td = debits.reduce((t, r) => t + r.paise, 0), tc = credits.reduce((t, r) => t + r.paise, 0);
  return {
    debits, credits, totalDebit: td, totalCredit: tc,
    text: csv([["Account", "Debit (INR)", "Credit (INR)"], ...debits.map((r) => [r.account, rupees(r.paise), ""]), ...credits.map((r) => [r.account, "", rupees(r.paise)]), ["Total", rupees(td), rupees(tc)]]),
    name: `journal-${run.period_month.slice(0, 7)}.csv`,
  };
}

/** Labour Codes check for the month: wages (basic, DA, retaining allowance) against total remuneration per person. */
export async function labourCodeReport(tx: Tx, actor: Actor, runId: string) {
  const { run, rows } = await lines(tx, actor, runId);
  const body = rows.filter((l) => slipped(l.action) && l.statutory?.labourCode).map((l) => {
    const c = l.statutory.labourCode!;
    return { number: l.number, name: l.name, department: l.department ?? "", wagesPaise: c.wagesPaise, remunerationPaise: c.remunerationPaise, pct: c.pct, shortfallPaise: c.shortfallPaise, ok: c.ok };
  });
  const text = csv([["Employee number", "Name", "Department", "Wages: basic + DA + retaining (INR)", "Total remuneration (INR)", "Wages %", "Shortfall to reach 50% (INR)", "Status"],
    ...body.map((r) => [r.number, r.name, r.department, rupees(r.wagesPaise), rupees(r.remunerationPaise), r.pct ?? "", rupees(r.shortfallPaise), r.ok ? "OK" : "Below 50%"])]);
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.report", diff: { kind: "labour_code", people: body.length, below: body.filter((r) => !r.ok).length } });
  return { rows: body, below: body.filter((r) => !r.ok).length, text, name: `labour-code-50pct-${run.period_month.slice(0, 7)}.csv` };
}

/** GL code per component code, for the accounting exports. */
async function glMap(tx: Tx) {
  return Object.fromEntries((await tx<{ code: string; gl_code: string | null }[]>`select code, gl_code from salary_components`).map((c) => [c.code, c.gl_code]));
}
const journalInput = (rows: Line[]) => rows.filter((l) => slipped(l.action)).map((l) => ({ earnings: l.earnings ?? [], deductions: l.deductions ?? [], employer: l.employer ?? [], netPaise: N(l.net_paise) }));

/** Tally journal voucher (XML import) for the month, ledgers named by GL code. */
export async function tallyExport(tx: Tx, actor: Actor, runId: string) {
  const { run, rows } = await lines(tx, actor, runId);
  const jl = journalLines(journalInput(rows), await glMap(tx));
  const [t] = await tx<{ name: string }[]>`select name from tenants where id = ${actor.tenant.id}`;
  const out = tallyJournalXml(jl, { company: run.legal_entity || t?.name || actor.tenant.name, month: run.period_month, voucherDate: monthEnd(run.period_month) });
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.report", diff: { kind: "tally", lines: jl.length, ...journalTotals(jl) } });
  return out;
}

/** Zoho Books manual-journal CSV for the month. */
export async function zohoExport(tx: Tx, actor: Actor, runId: string) {
  const { run, rows } = await lines(tx, actor, runId);
  const jl = journalLines(journalInput(rows), await glMap(tx));
  const out = zohoJournalCsv(jl, { month: run.period_month, voucherDate: monthEnd(run.period_month), reference: `PAYROLL-${run.period_month.slice(0, 7)}` });
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.report", diff: { kind: "zoho", lines: jl.length, ...journalTotals(jl) } });
  return out;
}
