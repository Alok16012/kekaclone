import "server-only";
import ExcelJS from "exceljs";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { appUrl, queueEmail } from "@/server/email";
import { simpleEmail } from "@/server/email/simple";
import { saveFile } from "@/server/storage";
import { todayIn } from "@/lib/dates";
import { reportByKey, STANDARD_REPORTS, type Header, type Params, type ReportResult, type StandardReport } from "./standard";
import { buildQuery, cell, DATASETS, datasetByKey, describeSchedule, nextRunAt, parseSchedule, reportRange, safeText, toCsv, validateDefinition, type Definition, type Schedule } from "./rules";

export const REPORTS_READ = "reports.read";
export const REPORTS_BUILD = "reports.build";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
export const hasAnywhere = (actor: Actor, permission: string) => (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(permission));
export const canReadReports = (actor: Actor) => hasAnywhere(actor, REPORTS_READ);
export const canBuildReports = (actor: Actor) => canReadReports(actor) && hasAnywhere(actor, REPORTS_BUILD);
/** Company-wide reports with no person behind each row (payroll runs) need an unscoped grant. */
export const canReadCompanyWide = (actor: Actor) => canFor(actor, REPORTS_READ, EVERYWHERE);

function assertReader(actor: Actor) { if (!canReadReports(actor)) throw new AppError("forbidden", "Reports are for people with report access."); }

/** Everyone the actor may report on: scoped grants narrow this to their departments / locations. Includes people who have left. */
export async function visibleEmployeeIds(tx: Tx, actor: Actor) {
  const people = await tx<(Placement & { id: string })[]>`select id, department_id, location_id, legal_entity_id, business_unit_id from employees`;
  return people.filter((p) => canFor(actor, REPORTS_READ, p)).map((p) => p.id);
}

// ---------- standard library ----------
export type LibraryEntry = Pick<StandardReport, "key" | "name" | "description" | "group" | "filters">;
export function library(actor: Actor): LibraryEntry[] {
  assertReader(actor);
  return STANDARD_REPORTS.filter((r) => r.key !== "payroll_runs" || canReadCompanyWide(actor)).map(({ key, name, description, group, filters }) => ({ key, name, description, group, filters }));
}

export async function filterOptions(tx: Tx, report: LibraryEntry) {
  const out: Record<string, { value: string; label: string }[]> = {};
  for (const f of report.filters) {
    if (f.options) out[f.key] = f.options;
    else if (f.optionsFrom === "departments") out[f.key] = await tx<{ value: string; label: string }[]>`select id as value, name as label from departments order by name`;
    else if (f.optionsFrom === "locations") out[f.key] = await tx<{ value: string; label: string }[]>`select id as value, name as label from locations order by name`;
    else if (f.optionsFrom === "courses") out[f.key] = await tx<{ value: string; label: string }[]>`select id as value, title as label from courses where status <> 'draft' order by title`;
    else if (f.optionsFrom === "projects") out[f.key] = await tx<{ value: string; label: string }[]>`select id as value, name as label from projects order by name`;
    else if (f.optionsFrom === "people") out[f.key] = await tx<{ value: string; label: string }[]>`select e.id as value, e.display_name || ' (' || e.employee_number || ')' as label from employees e where e.user_id is not null order by e.display_name`;
  }
  return out;
}

export function cleanParams(report: LibraryEntry, raw: Record<string, string | undefined>, today = todayIn()): Params {
  const range = reportRange(raw.from ?? null, raw.to ?? null, today);
  const params: Params = { from: range.from, to: range.to };
  for (const f of report.filters) if (f.type === "select" && typeof raw[f.key] === "string") params[f.key] = raw[f.key]!.slice(0, 60);
  return params;
}

export async function runStandard(tx: Tx, actor: Actor, key: string, raw: Record<string, string | undefined>, today = todayIn()): Promise<ReportResult & { params: Params; report: LibraryEntry }> {
  const report = library(actor).find((r) => r.key === key);
  if (!report) throw new AppError("not_found", "That report doesn't exist or isn't available to you.");
  const full = reportByKey(key)!;
  const ids = await visibleEmployeeIds(tx, actor);
  const params = cleanParams(report, raw, today);
  const res = await full.run(tx, { ids, params, today });
  return { ...res, params, report };
}

// ---------- export ----------
export type Exported = { bytes: Uint8Array; name: string; mime: string };

export async function toFile(headers: Header[], rows: Record<string, unknown>[], name: string, format: "csv" | "xlsx"): Promise<Exported> {
  if (format === "csv") {
    const csv = toCsv([headers.map((h) => h.label), ...rows.map((r) => headers.map((h) => { const v = cell(h.type, r[h.key]); return h.type === "text" ? safeText(v) : v; }))]);
    return { bytes: new TextEncoder().encode("﻿" + csv), name: `${name}.csv`, mime: "text/csv; charset=utf-8" };
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = "erp";
  const ws = wb.addWorksheet(name.slice(0, 30));
  const h = ws.addRow(headers.map((x) => x.label));
  h.font = { bold: true };
  for (const r of rows) ws.addRow(headers.map((x) => {
    const v = r[x.key];
    if (v == null) return "";
    if (x.type === "money") return Number(v) / 100;
    if (x.type === "number") return Number(v);
    if (x.type === "bool") return v ? "Yes" : "No";
    if (x.type === "date") return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    return safeText(String(v));
  }));
  headers.forEach((x, i) => { const c = ws.getColumn(i + 1); c.width = Math.min(40, Math.max(12, x.label.length + 4)); if (x.type === "money") c.numFmt = "#,##,##0.00"; });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return { bytes: new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer), name: `${name}.xlsx`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}

export async function exportStandard(tx: Tx, actor: Actor, key: string, raw: Record<string, string | undefined>, format: "csv" | "xlsx") {
  const r = await runStandard(tx, actor, key, raw);
  await audit(tx, actor, { entityType: "report", action: "export", diff: { key, format, params: r.params, rows: r.rows.length } });
  return toFile(r.headers, r.rows, `${key}-${r.params.from}-to-${r.params.to}`, format);
}

// ---------- builder ----------
export const datasets = () => DATASETS.map((d) => ({ key: d.key, label: d.label, description: d.description, columns: d.columns.map(({ key, label, type }) => ({ key, label, type })) }));

export async function preview(tx: Tx, actor: Actor, datasetKey: string, rawDef: unknown): Promise<ReportResult & { def: Definition }> {
  if (!canBuildReports(actor)) throw new AppError("forbidden", "The report builder needs report-building access.");
  const ds = datasetByKey(datasetKey);
  if (!ds) throw new AppError("invalid", "Pick a dataset.", "dataset");
  const v = validateDefinition(ds, rawDef);
  if (!v.ok) throw new AppError("invalid", v.problems[0].message, v.problems[0].field);
  const ids = await visibleEmployeeIds(tx, actor);
  const q = buildQuery(ds, v.def);
  const rows = await tx.unsafe(q.sql, [ids, ...q.params] as never[]) as unknown as Record<string, unknown>[];
  return { headers: q.headers, rows, def: v.def };
}

export type SavedRow = {
  id: string; name: string; dataset: string; kind: "custom" | "standard"; definition: Definition; owner_user_id: string | null; owner: string | null; mine: boolean;
  shared_roles: string[]; schedule: Schedule | null; schedule_text: string | null; next_run_at: Date | null; last_run_at: Date | null; updated_at: Date;
};

/** Saved reports the actor owns, plus those shared with one of their roles. */
export async function listSaved(tx: Tx, actor: Actor): Promise<SavedRow[]> {
  assertReader(actor);
  const rows = await tx<(Omit<SavedRow, "mine" | "schedule" | "schedule_text"> & { schedule: unknown })[]>`
    select s.id, s.name, s.dataset, s.kind, s.definition, s.owner_user_id, coalesce(e.display_name, u.email::text) as owner, s.shared_roles, s.schedule, s.next_run_at, s.last_run_at, s.updated_at
    from saved_reports s left join users u on u.id = s.owner_user_id left join employees e on e.user_id = u.id
    where s.owner_user_id = ${actor.userId} or s.shared_roles && ${actor.roles}::text[]
    order by s.updated_at desc`;
  return rows.map((r) => { const schedule = parseSchedule(r.schedule); return { ...r, mine: r.owner_user_id === actor.userId, schedule, schedule_text: schedule ? describeSchedule(schedule) : null } as SavedRow; });
}

export async function savedReport(tx: Tx, actor: Actor, id: string) {
  return (await listSaved(tx, actor)).find((s) => s.id === id) ?? null;
}

export async function saveReport(tx: Tx, actor: Actor, id: string | null, input: { name: string; dataset: string; definition: unknown; sharedRoles: string[] }) {
  if (!canBuildReports(actor)) throw new AppError("forbidden", "The report builder needs report-building access.");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("invalid", "Give the report a name.", "name");
  const ds = datasetByKey(input.dataset);
  if (!ds) throw new AppError("invalid", "Pick a dataset.", "dataset");
  const v = validateDefinition(ds, input.definition);
  if (!v.ok) throw new AppError("invalid", v.problems[0].message, v.problems[0].field);
  const roles = [...new Set(input.sharedRoles.filter((r) => typeof r === "string" && r.length <= 60))];
  if (roles.length) {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from roles where key = any(${roles}::text[])`;
    if (n !== roles.length) throw new AppError("invalid", "One of the roles you picked doesn't exist.", "sharedRoles");
  }
  if (id) {
    const [r] = await tx<{ id: string }[]>`update saved_reports set name = ${name}, dataset = ${ds.key}, definition = ${tx.json(v.def as never)}, shared_roles = ${roles}::text[], updated_at = now()
      where id = ${id} and owner_user_id = ${actor.userId} returning id`;
    if (!r) throw new AppError("not_found", "Report not found, or it isn't yours to edit.");
    await audit(tx, actor, { entityType: "saved_report", entityId: id, action: "update", diff: { name, dataset: ds.key, shared_roles: roles } });
    return r;
  }
  const [r] = await tx<{ id: string }[]>`insert into saved_reports (tenant_id, owner_user_id, name, dataset, definition, shared_roles) values (${actor.tenant.id}, ${actor.userId}, ${name}, ${ds.key}, ${tx.json(v.def as never)}, ${roles}::text[]) returning id`;
  await audit(tx, actor, { entityType: "saved_report", entityId: r.id, action: "create", diff: { name, dataset: ds.key, shared_roles: roles } });
  return r;
}

export async function deleteReport(tx: Tx, actor: Actor, id: string) {
  const r = await tx`delete from saved_reports where id = ${id} and owner_user_id = ${actor.userId}`;
  if (!r.count) throw new AppError("not_found", "Report not found, or it isn't yours to delete.");
  await audit(tx, actor, { entityType: "saved_report", entityId: id, action: "delete" });
}

/** Run a saved report as the reader: shared reports still only show the people the reader may see. */
export async function runSaved(tx: Tx, actor: Actor, id: string): Promise<ReportResult & { saved: SavedRow }> {
  const saved = await savedReport(tx, actor, id);
  if (!saved) throw new AppError("not_found", "Report not found.");
  const ds = datasetByKey(saved.dataset);
  if (!ds) throw new AppError("invalid", "This report's dataset no longer exists.");
  const v = validateDefinition(ds, saved.definition);
  if (!v.ok) throw new AppError("invalid", v.problems[0].message);
  const ids = await visibleEmployeeIds(tx, actor);
  const q = buildQuery(ds, v.def);
  const rows = await tx.unsafe(q.sql, [ids, ...q.params] as never[]) as unknown as Record<string, unknown>[];
  return { headers: q.headers, rows, saved };
}

export async function exportSaved(tx: Tx, actor: Actor, id: string, format: "csv" | "xlsx") {
  const r = await runSaved(tx, actor, id);
  await audit(tx, actor, { entityType: "saved_report", entityId: id, action: "export", diff: { format, rows: r.rows.length } });
  return toFile(r.headers, r.rows, r.saved.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "report", format);
}

// ---------- schedules ----------
export async function setSchedule(tx: Tx, actor: Actor, id: string, raw: unknown, now = new Date()) {
  if (!canBuildReports(actor)) throw new AppError("forbidden", "Scheduling needs report-building access.");
  const [s] = await tx<{ id: string }[]>`select id from saved_reports where id = ${id} and owner_user_id = ${actor.userId}`;
  if (!s) throw new AppError("not_found", "Report not found, or it isn't yours to schedule.");
  if (raw == null) {
    await tx`update saved_reports set schedule = null, next_run_at = null, updated_at = now() where id = ${id}`;
    await audit(tx, actor, { entityType: "saved_report", entityId: id, action: "schedule.clear" });
    return null;
  }
  const schedule = parseSchedule(raw);
  if (!schedule) throw new AppError("invalid", "Pick how often, at what hour, and at least one person to send it to.", "schedule");
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from employees e join users u on u.id = e.user_id where e.id = any(${schedule.recipients}::uuid[]) and e.status <> 'relieved'`;
  if (n !== schedule.recipients.length) throw new AppError("invalid", "Recipients must be people with an erp account.", "recipients");
  const next = nextRunAt(schedule, now);
  await tx`update saved_reports set schedule = ${tx.json(schedule)}, next_run_at = ${next}, updated_at = now() where id = ${id}`;
  await audit(tx, actor, { entityType: "saved_report", entityId: id, action: "schedule.set", diff: { ...schedule } });
  return { schedule, next_run_at: next };
}

/** A person's effective grants, for running a scheduled report exactly as its owner would see it. */
export async function actorForUser(tx: Tx, tenant: Actor["tenant"], userId: string): Promise<Actor | null> {
  const [row] = await tx<{ user_id: string; email: string; employee_id: string; display_name: string }[]>`
    select u.id as user_id, u.email::text as email, e.id as employee_id, e.display_name from users u join employees e on e.user_id = u.id where u.id = ${userId} and u.status = 'active' and e.status <> 'relieved'`;
  if (!row) return null;
  const roles = await tx<{ key: string; permissions: string[]; scopes: Scope[] }[]>`select r.key, r.permissions, ra.scopes from role_assignments ra join roles r on r.id = ra.role_id where ra.employee_id = ${row.employee_id}`;
  return { tenant, userId: row.user_id, employeeId: row.employee_id, name: row.display_name, email: row.email, title: null, roles: roles.map((r) => r.key),
    permissions: new Set(roles.flatMap((r) => r.permissions)), grants: roles.map((r) => ({ permissions: r.permissions, scopes: r.scopes ?? [] })) };
}

/** Scheduled deliveries that are due: run as the owner, store the file, tell each recipient. Returns how many were sent. */
export async function deliverDue(tx: Tx, tenant: Actor["tenant"], now = new Date()) {
  const due = await tx<{ id: string; name: string; owner_user_id: string | null; schedule: unknown }[]>`
    select id, name, owner_user_id, schedule from saved_reports where next_run_at is not null and next_run_at <= ${now} order by next_run_at for update skip locked`;
  let sent = 0;
  for (const s of due) {
    const schedule = parseSchedule(s.schedule);
    if (!schedule || !s.owner_user_id) { await tx`update saved_reports set schedule = null, next_run_at = null where id = ${s.id}`; continue; }
    const owner = await actorForUser(tx, tenant, s.owner_user_id);
    const next = nextRunAt(schedule, now);
    if (!owner || !canBuildReports(owner)) {   // owner left or lost access: stop the schedule rather than leak their old view
      await tx`update saved_reports set schedule = null, next_run_at = null, last_run_at = ${now} where id = ${s.id}`;
      continue;
    }
    try {
      const r = await runSaved(tx, owner, s.id);
      const file = await toFile(r.headers, r.rows, `${s.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "report"}-${todayIn("Asia/Kolkata", now)}`, schedule.format);
      const fileId = await saveFile(tx, { tenantId: tenant.id, userId: s.owner_user_id, name: file.name, mime: file.mime.split(";")[0], bytes: file.bytes, ext: schedule.format });
      const [d] = await tx<{ id: string }[]>`insert into report_deliveries (tenant_id, saved_report_id, file_id, recipient_employee_ids, row_count) values (${tenant.id}, ${s.id}, ${fileId}, ${schedule.recipients}::uuid[], ${r.rows.length}) returning id`;
      const people = await tx<{ id: string; email: string | null; name: string }[]>`select e.id, u.email::text as email, e.display_name as name from employees e left join users u on u.id = e.user_id where e.id = any(${schedule.recipients}::uuid[]) and e.status <> 'relieved'`;
      const link = `/reports/deliveries/${d.id}`;
      for (const p of people) {
        await notifyEmployee(tx, tenant.id, p.id, "report.delivered", `Report: ${s.name}`, `${r.rows.length} rows · ${file.name}`, link);
        if (p.email) await queueEmail(tx, tenant.id, { kind: "report.scheduled", to: p.email, ...simpleEmail({ company: tenant.name, subject: `Scheduled report: ${s.name}`, heading: s.name,
          paragraphs: [`Hi ${p.name.split(" ")[0]}, your scheduled report is ready (${r.rows.length} rows). Sign in to download it.`], button: { label: "Download the report", url: appUrl(tenant.subdomain, link) },
          footnote: "The file is only available to the people it was sent to." }) });
      }
      await audit(tx, { tenantId: tenant.id, userId: null }, { entityType: "saved_report", entityId: s.id, action: "schedule.run", diff: { rows: r.rows.length, recipients: schedule.recipients, delivery_id: d.id } });
      sent++;
    } catch (e) {
      await audit(tx, { tenantId: tenant.id, userId: null }, { entityType: "saved_report", entityId: s.id, action: "schedule.failed", diff: { error: String((e as Error).message).slice(0, 300) } });
    }
    await tx`update saved_reports set next_run_at = ${next}, last_run_at = ${now} where id = ${s.id}`;
  }
  return sent;
}

/** A delivered file opens for its recipients and the report's owner only. */
export async function deliveryFileFor(tx: Tx, actor: Actor, deliveryId: string) {
  const [d] = await tx<{ file_id: string; storage_key: string; name: string; mime: string; owner_user_id: string | null; recipients: string[] }[]>`
    select d.file_id, f.storage_key, f.name, f.mime, s.owner_user_id, d.recipient_employee_ids as recipients
    from report_deliveries d join files f on f.id = d.file_id join saved_reports s on s.id = d.saved_report_id where d.id = ${deliveryId}`;
  if (!d) return null;
  if (d.owner_user_id !== actor.userId && !d.recipients.includes(actor.employeeId)) return null;
  return d;
}

export async function recentDeliveries(tx: Tx, actor: Actor, savedReportId: string) {
  return tx<{ id: string; created_at: Date; row_count: number; name: string }[]>`
    select d.id, d.created_at, d.row_count, f.name from report_deliveries d join files f on f.id = d.file_id join saved_reports s on s.id = d.saved_report_id
    where d.saved_report_id = ${savedReportId} and (s.owner_user_id = ${actor.userId} or ${actor.employeeId}::uuid = any(d.recipient_employee_ids)) order by d.created_at desc limit 10`;
}

export async function roleOptions(tx: Tx) {
  return tx<{ key: string; name: string }[]>`select key, name from roles order by name`;
}
