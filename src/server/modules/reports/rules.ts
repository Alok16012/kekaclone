/** Pure rules for the report builder: whitelisted datasets, definition validation, SQL assembly with parameters, CSV, schedules. */
import type { ISODate } from "@/lib/dates";

export type ColType = "text" | "number" | "date" | "bool" | "money";
export type Column = { key: string; label: string; sql: string; type: ColType };
export type Dataset = { key: string; label: string; description: string; from: string; columns: Column[]; defaultSort: string };

/**
 * Every dataset joins `employees e`, so scope (which people the reader may see) is always `e.id = any($ids)`.
 * SQL fragments here are the only SQL the builder ever emits; user input only ever becomes parameters.
 */
export const DATASETS: Dataset[] = [
  { key: "employees", label: "People", description: "One row per person with job details.", defaultSort: "name",
    from: "employees e left join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id left join locations l on l.id = e.location_id left join legal_entities le on le.id = e.legal_entity_id left join employees m on m.id = e.manager_id",
    columns: [
      { key: "number", label: "Employee number", sql: "e.employee_number", type: "text" }, { key: "name", label: "Name", sql: "e.display_name", type: "text" },
      { key: "email", label: "Work email", sql: "e.work_email::text", type: "text" }, { key: "department", label: "Department", sql: "d.name", type: "text" },
      { key: "designation", label: "Designation", sql: "g.title", type: "text" }, { key: "location", label: "Location", sql: "l.name", type: "text" },
      { key: "legal_entity", label: "Legal entity", sql: "le.name", type: "text" }, { key: "manager", label: "Manager", sql: "m.display_name", type: "text" },
      { key: "joining_date", label: "Joining date", sql: "e.joining_date", type: "date" }, { key: "status", label: "Status", sql: "e.status", type: "text" },
      { key: "worker_type", label: "Worker type", sql: "e.worker_type", type: "text" }, { key: "time_type", label: "Time type", sql: "e.time_type", type: "text" },
      { key: "gender", label: "Gender", sql: "e.gender", type: "text" }, { key: "dob", label: "Date of birth", sql: "e.dob", type: "date" },
      { key: "probation_status", label: "Probation", sql: "e.probation_status", type: "text" }, { key: "exit_date", label: "Exit date", sql: "e.exit_date", type: "date" },
    ] },
  { key: "leave_requests", label: "Leave requests", description: "Every leave application with its type and status.", defaultSort: "from_date",
    from: "leave_requests r join employees e on e.id = r.employee_id join leave_types t on t.id = r.leave_type_id left join departments d on d.id = e.department_id",
    columns: [
      { key: "name", label: "Name", sql: "e.display_name", type: "text" }, { key: "number", label: "Employee number", sql: "e.employee_number", type: "text" },
      { key: "department", label: "Department", sql: "d.name", type: "text" }, { key: "type", label: "Leave type", sql: "t.name", type: "text" },
      { key: "from_date", label: "From", sql: "r.from_date", type: "date" }, { key: "to_date", label: "To", sql: "r.to_date", type: "date" },
      { key: "days", label: "Days", sql: "r.days::float", type: "number" }, { key: "status", label: "Status", sql: "r.status", type: "text" },
      { key: "note", label: "Note", sql: "r.note", type: "text" }, { key: "applied_at", label: "Applied on", sql: "(r.created_at at time zone 'Asia/Kolkata')::date", type: "date" },
    ] },
  { key: "attendance_days", label: "Attendance days", description: "One row per person per day with hours and late minutes.", defaultSort: "date",
    from: "attendance_days a join employees e on e.id = a.employee_id left join departments d on d.id = e.department_id left join shifts s on s.id = a.shift_id",
    columns: [
      { key: "name", label: "Name", sql: "e.display_name", type: "text" }, { key: "number", label: "Employee number", sql: "e.employee_number", type: "text" },
      { key: "department", label: "Department", sql: "d.name", type: "text" }, { key: "date", label: "Date", sql: "a.date", type: "date" },
      { key: "day_type", label: "Day type", sql: "a.day_type", type: "text" }, { key: "status", label: "Status", sql: "a.status", type: "text" },
      { key: "shift", label: "Shift", sql: "s.name", type: "text" }, { key: "first_in", label: "First in", sql: "to_char(a.first_in at time zone 'Asia/Kolkata', 'HH24:MI')", type: "text" },
      { key: "last_out", label: "Last out", sql: "to_char(a.last_out at time zone 'Asia/Kolkata', 'HH24:MI')", type: "text" },
      { key: "effective_hours", label: "Effective hours", sql: "round(a.effective_minutes / 60.0, 2)::float", type: "number" }, { key: "gross_hours", label: "Gross hours", sql: "round(a.gross_minutes / 60.0, 2)::float", type: "number" },
      { key: "late_minutes", label: "Late by (min)", sql: "a.late_minutes", type: "number" }, { key: "early_minutes", label: "Left early by (min)", sql: "a.early_minutes", type: "number" },
      { key: "overtime_minutes", label: "Overtime (min)", sql: "a.overtime_minutes", type: "number" },
    ] },
  { key: "expense_claims", label: "Expense claims", description: "Claims with totals, payout mode and status.", defaultSort: "submitted_at",
    from: "expense_claims c join employees e on e.id = c.employee_id left join departments d on d.id = e.department_id",
    columns: [
      { key: "claim_number", label: "Claim", sql: "c.number", type: "number" }, { key: "name", label: "Name", sql: "e.display_name", type: "text" },
      { key: "department", label: "Department", sql: "d.name", type: "text" }, { key: "title", label: "Title", sql: "c.title", type: "text" },
      { key: "total", label: "Total (INR)", sql: "c.total_paise", type: "money" }, { key: "status", label: "Status", sql: "c.status", type: "text" },
      { key: "payout", label: "Payout", sql: "c.payout", type: "text" }, { key: "submitted_at", label: "Submitted on", sql: "(c.submitted_at at time zone 'Asia/Kolkata')::date", type: "date" },
    ] },
  { key: "tickets", label: "Helpdesk tickets", description: "Tickets with category, assignee, status and SLA timing.", defaultSort: "raised_at",
    from: "tickets t join employees e on e.id = t.raised_by_employee_id join ticket_categories k on k.id = t.category_id left join employees a on a.id = t.assignee_employee_id left join departments d on d.id = e.department_id",
    columns: [
      { key: "ticket_number", label: "Ticket", sql: "t.number", type: "number" }, { key: "title", label: "Title", sql: "t.title", type: "text" },
      { key: "category", label: "Category", sql: "k.name", type: "text" }, { key: "name", label: "Raised by", sql: "e.display_name", type: "text" },
      { key: "department", label: "Department", sql: "d.name", type: "text" }, { key: "assignee", label: "Assignee", sql: "a.display_name", type: "text" },
      { key: "priority", label: "Priority", sql: "t.priority", type: "text" }, { key: "status", label: "Status", sql: "t.status", type: "text" },
      { key: "raised_at", label: "Raised on", sql: "(t.created_at at time zone 'Asia/Kolkata')::date", type: "date" }, { key: "closed_at", label: "Closed on", sql: "(t.closed_at at time zone 'Asia/Kolkata')::date", type: "date" },
      { key: "first_response_met", label: "First response in time", sql: "(t.first_response_due_at is null or (t.first_responded_at is not null and t.first_responded_at <= t.first_response_due_at))", type: "bool" },
      { key: "resolution_met", label: "Resolved in time", sql: "(t.resolution_due_at is null or (t.closed_at is not null and t.closed_at <= t.resolution_due_at))", type: "bool" },
      { key: "hours_to_close", label: "Hours to close", sql: "round(extract(epoch from (t.closed_at - t.created_at)) / 3600)::float", type: "number" },
    ] },
  { key: "time_entries", label: "Timesheet entries", description: "Logged hours by person, project, task and day.", defaultSort: "date",
    from: "time_entries x join timesheets ts on ts.id = x.timesheet_id join employees e on e.id = ts.employee_id join projects p on p.id = x.project_id left join clients c on c.id = p.client_id left join project_tasks k on k.id = x.task_id left join departments d on d.id = e.department_id",
    columns: [
      { key: "name", label: "Name", sql: "e.display_name", type: "text" }, { key: "department", label: "Department", sql: "d.name", type: "text" },
      { key: "client", label: "Client", sql: "c.name", type: "text" }, { key: "project", label: "Project", sql: "p.name", type: "text" }, { key: "project_code", label: "Project code", sql: "p.code", type: "text" },
      { key: "task", label: "Task", sql: "k.name", type: "text" }, { key: "date", label: "Date", sql: "x.date", type: "date" },
      { key: "hours", label: "Hours", sql: "round(x.minutes / 60.0, 2)::float", type: "number" }, { key: "billable", label: "Billable", sql: "x.is_billable", type: "bool" },
      { key: "timesheet_status", label: "Timesheet status", sql: "ts.status", type: "text" }, { key: "invoiced", label: "Invoiced", sql: "(x.invoice_id is not null)", type: "bool" }, { key: "note", label: "Note", sql: "x.note", type: "text" },
    ] },
  { key: "enrollments", label: "Learning", description: "Course enrolments with progress and completion.", defaultSort: "name",
    from: "enrollments n join employees e on e.id = n.employee_id join courses c on c.id = n.course_id left join departments d on d.id = e.department_id",
    columns: [
      { key: "name", label: "Name", sql: "e.display_name", type: "text" }, { key: "department", label: "Department", sql: "d.name", type: "text" },
      { key: "course", label: "Course", sql: "c.title", type: "text" }, { key: "percent", label: "Progress %", sql: "n.percent::float", type: "number" },
      { key: "due_date", label: "Due", sql: "n.due_date", type: "date" }, { key: "completed_on", label: "Completed on", sql: "(n.completed_at at time zone 'Asia/Kolkata')::date", type: "date" },
      { key: "completed", label: "Completed", sql: "(n.completed_at is not null)", type: "bool" }, { key: "enrolled_on", label: "Enrolled on", sql: "(n.created_at at time zone 'Asia/Kolkata')::date", type: "date" },
    ] },
];
export const datasetByKey = (key: string) => DATASETS.find((d) => d.key === key) ?? null;

export const OPS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "between", "in", "is_null", "not_null"] as const;
export type Op = (typeof OPS)[number];
export const OP_LABEL: Record<Op, string> = { eq: "is", neq: "is not", contains: "contains", gt: "after / more than", gte: "on or after / at least", lt: "before / less than", lte: "on or before / at most", between: "between", in: "is one of", is_null: "is empty", not_null: "is not empty" };
export const OPS_FOR: Record<ColType, Op[]> = {
  text: ["eq", "neq", "contains", "in", "is_null", "not_null"], number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"],
  money: ["gt", "gte", "lt", "lte", "between"], date: ["eq", "gt", "gte", "lt", "lte", "between", "is_null", "not_null"], bool: ["eq"],
};
export const AGGS = ["count", "sum", "avg", "min", "max"] as const;
export type Agg = (typeof AGGS)[number];

export type Filter = { col: string; op: Op; value?: unknown };
export type Definition = { columns: string[]; filters: Filter[]; groupBy: string | null; aggregates: { fn: Agg; col: string | null }[]; sort: { col: string; dir: "asc" | "desc" } | null; limit: number };
export type Problem = { field: string; message: string };
export const MAX_ROWS = 5000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanValue(type: ColType, op: Op, raw: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (op === "is_null" || op === "not_null") return { ok: true, value: null };
  const one = (v: unknown) => {
    if (type === "date") return typeof v === "string" && DATE_RE.test(v) ? v : null;
    if (type === "number" || type === "money") { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? (type === "money" ? Math.round(n * 100) : n) : null; }
    if (type === "bool") return v === true || v === "true" ? true : v === false || v === "false" ? false : null;
    return typeof v === "string" && v.length <= 200 ? v : null;
  };
  if (op === "between") {
    const arr = Array.isArray(raw) ? raw : [];
    const a = one(arr[0]), b = one(arr[1]);
    return a == null || b == null ? { ok: false, message: "Between needs two values." } : { ok: true, value: [a, b] };
  }
  if (op === "in") {
    const arr = (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : []).map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "").map(one);
    return !arr.length || arr.some((x) => x == null) ? { ok: false, message: "Give one or more values." } : { ok: true, value: arr.slice(0, 100) };
  }
  const v = one(raw);
  return v == null ? { ok: false, message: type === "date" ? "Use a date like 2026-04-01." : "Enter a value." } : { ok: true, value: v };
}

/** Validates and normalises a definition against its dataset. Unknown columns, ops and types are rejected. */
export function validateDefinition(ds: Dataset, raw: unknown): { ok: true; def: Definition } | { ok: false; problems: Problem[] } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const problems: Problem[] = [];
  const col = (k: unknown) => (typeof k === "string" ? ds.columns.find((c) => c.key === k) ?? null : null);
  const columns = [...new Set((Array.isArray(r.columns) ? r.columns : []).filter((k): k is string => !!col(k)))];
  const groupBy = col(r.groupBy)?.key ?? null;
  if (!groupBy && !columns.length) problems.push({ field: "columns", message: "Pick at least one column." });
  const filters: Filter[] = [];
  (Array.isArray(r.filters) ? r.filters : []).forEach((f, i) => {
    const x = (f ?? {}) as Record<string, unknown>;
    const c = col(x.col);
    if (!c) { problems.push({ field: `filters.${i}`, message: "Pick a column to filter on." }); return; }
    const op = typeof x.op === "string" && (OPS as readonly string[]).includes(x.op) ? (x.op as Op) : null;
    if (!op || !OPS_FOR[c.type].includes(op)) { problems.push({ field: `filters.${i}`, message: `That comparison doesn't work for ${c.label}.` }); return; }
    const v = cleanValue(c.type, op, x.value);
    if (!v.ok) { problems.push({ field: `filters.${i}`, message: `${c.label}: ${v.message}` }); return; }
    filters.push({ col: c.key, op, value: v.value });
  });
  if (filters.length > 20) problems.push({ field: "filters", message: "At most 20 filters." });
  const aggregates: Definition["aggregates"] = [];
  if (groupBy) {
    for (const a of Array.isArray(r.aggregates) ? r.aggregates : []) {
      const x = (a ?? {}) as Record<string, unknown>;
      const fn = typeof x.fn === "string" && (AGGS as readonly string[]).includes(x.fn) ? (x.fn as Agg) : null;
      if (!fn) continue;
      const c = fn === "count" ? null : col(x.col);
      if (fn !== "count" && (!c || !["number", "money"].includes(c.type))) { problems.push({ field: "aggregates", message: `${fn} needs a number column.` }); continue; }
      aggregates.push({ fn, col: c?.key ?? null });
    }
    if (!aggregates.length) aggregates.push({ fn: "count", col: null });
  }
  let sort: Definition["sort"] = null;
  const s = (r.sort ?? null) as Record<string, unknown> | null;
  if (s && typeof s.col === "string") {
    const dir = s.dir === "desc" ? "desc" : "asc";
    const allowed = groupBy ? [groupBy, ...aggregates.map((a) => `${a.fn}_${a.col ?? "rows"}`)] : columns;
    if (allowed.includes(s.col)) sort = { col: s.col, dir };
  }
  const limit = Math.min(MAX_ROWS, Math.max(1, Math.floor(Number(r.limit)) || MAX_ROWS));
  if (problems.length) return { ok: false, problems };
  return { ok: true, def: { columns, filters, groupBy, aggregates, sort, limit } };
}

export type Query = { sql: string; params: unknown[]; headers: { key: string; label: string; type: ColType }[] };

/** The SELECT for a definition. $1 is always the array of visible employee ids. Only whitelisted fragments reach the SQL text. */
export function buildQuery(ds: Dataset, def: Definition): Query {
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length + 1}`; };
  const colOf = (k: string) => ds.columns.find((c) => c.key === k)!;
  const where = ["e.id = any($1::uuid[])"];
  for (const f of def.filters) {
    const c = colOf(f.col);
    const cast = c.type === "date" ? "::date" : c.type === "number" || c.type === "money" ? "::numeric" : c.type === "bool" ? "::boolean" : "::text";
    switch (f.op) {
      case "eq": where.push(`${c.sql} = ${p(f.value)}${cast}`); break;
      case "neq": where.push(`${c.sql} is distinct from ${p(f.value)}${cast}`); break;
      case "contains": where.push(`${c.sql} ilike ${p(`%${String(f.value).replace(/[\\%_]/g, (m) => "\\" + m)}%`)}`); break;
      case "gt": where.push(`${c.sql} > ${p(f.value)}${cast}`); break;
      case "gte": where.push(`${c.sql} >= ${p(f.value)}${cast}`); break;
      case "lt": where.push(`${c.sql} < ${p(f.value)}${cast}`); break;
      case "lte": where.push(`${c.sql} <= ${p(f.value)}${cast}`); break;
      case "between": { const [a, b] = f.value as unknown[]; where.push(`${c.sql} between ${p(a)}${cast} and ${p(b)}${cast}`); break; }
      case "in": where.push(`${c.sql}${cast} = any(${p(f.value)}${cast}[])`); break;
      case "is_null": where.push(`${c.sql} is null`); break;
      case "not_null": where.push(`${c.sql} is not null`); break;
    }
  }
  let select: string[], headers: Query["headers"], groupSql = "";
  if (def.groupBy) {
    const g = colOf(def.groupBy);
    select = [`${g.sql} as "${g.key}"`];
    headers = [{ key: g.key, label: g.label, type: g.type }];
    for (const a of def.aggregates) {
      const key = `${a.fn}_${a.col ?? "rows"}`;
      if (a.fn === "count") { select.push(`count(*)::int as "${key}"`); headers.push({ key, label: "Rows", type: "number" }); continue; }
      const c = colOf(a.col!);
      const expr = c.type === "money" ? `${a.fn}(${c.sql})::bigint` : `round(${a.fn}(${c.sql})::numeric, 2)::float`;
      select.push(`${expr} as "${key}"`);
      headers.push({ key, label: `${{ sum: "Total", avg: "Average", min: "Lowest", max: "Highest" }[a.fn]} ${c.label.toLowerCase()}`, type: c.type });
    }
    groupSql = ` group by ${g.sql}`;
  } else {
    select = def.columns.map((k) => `${colOf(k).sql} as "${k}"`);
    headers = def.columns.map((k) => { const c = colOf(k); return { key: c.key, label: c.label, type: c.type }; });
  }
  const sortCol = def.sort?.col ?? (def.groupBy ? def.groupBy : def.columns.includes(ds.defaultSort) ? ds.defaultSort : def.columns[0]);
  const sortExpr = def.groupBy && sortCol !== def.groupBy ? `"${sortCol}"` : colOf(sortCol).sql;
  const sql = `select ${select.join(", ")} from ${ds.from} where ${where.join(" and ")}${groupSql} order by ${sortExpr} ${def.sort?.dir ?? "asc"} nulls last limit ${def.limit}`;
  return { sql, params, headers };
}

// ---------- output ----------
export function cell(type: ColType, v: unknown): string {
  if (v == null) return "";
  if (type === "money") return (Number(v) / 100).toFixed(2);
  if (type === "bool") return v ? "Yes" : "No";
  if (type === "date") return v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  return String(v);
}
export function toCsv(rows: unknown[][]): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
/** Spreadsheet formula injection guard for text cells. */
export const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);

// ---------- schedules ----------
export type Schedule = { frequency: "daily" | "weekly" | "monthly"; weekday: number; day: number; hour: number; recipients: string[]; format: "csv" | "xlsx" };
export function parseSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const frequency = r.frequency === "daily" || r.frequency === "weekly" || r.frequency === "monthly" ? r.frequency : null;
  if (!frequency) return null;
  const hour = Number(r.hour), weekday = Number(r.weekday ?? 1), day = Number(r.day ?? 1);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (frequency === "weekly" && (!Number.isInteger(weekday) || weekday < 1 || weekday > 7)) return null;
  if (frequency === "monthly" && (!Number.isInteger(day) || day < 1 || day > 28)) return null;
  const recipients = Array.isArray(r.recipients) ? [...new Set(r.recipients.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))] : [];
  if (!recipients.length || recipients.length > 20) return null;
  return { frequency, weekday: frequency === "weekly" ? weekday : 1, day: frequency === "monthly" ? day : 1, hour, recipients, format: r.format === "csv" ? "csv" : "xlsx" };
}

/** Next run strictly after `now`, at `hour` IST on the schedule's day. */
export function nextRunAt(s: Schedule, now: Date): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);          // shift to IST wall clock, work in UTC fields
  const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, s.hour, 0, 0) - 330 * 60_000);
  let y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  for (let i = 0; i < 400; i++) {
    const cand = at(y, m, d);
    const dow = ((new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7) + 1;   // 1 = Monday
    const matches = s.frequency === "daily" || (s.frequency === "weekly" && dow === s.weekday) || (s.frequency === "monthly" && new Date(Date.UTC(y, m, d)).getUTCDate() === s.day);
    if (matches && cand > now) return cand;
    const n = new Date(Date.UTC(y, m, d + 1)); y = n.getUTCFullYear(); m = n.getUTCMonth(); d = n.getUTCDate();
  }
  return at(y, m, d);
}

export function describeSchedule(s: Schedule) {
  const h = `${String(s.hour).padStart(2, "0")}:00 IST`;
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  if (s.frequency === "daily") return `Every day at ${h}`;
  if (s.frequency === "weekly") return `Every ${days[s.weekday - 1]} at ${h}`;
  return `On the ${s.day}${s.day === 1 ? "st" : s.day === 2 ? "nd" : s.day === 3 ? "rd" : "th"} of every month at ${h}`;
}

/** Date-range filters for standard reports: default to the current month, capped to one year. */
export function reportRange(from: string | null, to: string | null, today: ISODate): { from: ISODate; to: ISODate } {
  const f = from && DATE_RE.test(from) ? from : today.slice(0, 8) + "01";
  let t = to && DATE_RE.test(to) ? to : today;
  if (t < f) t = f;
  const max = new Date(Date.parse(f) + 366 * 86400000).toISOString().slice(0, 10);
  if (t > max) t = max;
  return { from: f, to: t };
}
