import "server-only";
import type { Tx } from "@/server/db";
import { decodePageCursor, encodePageCursor, pageLimit, type ApiScope } from "./rules";

/**
 * Read-only data for the public API v1. Directory fields only: no pay, bank, identity numbers or personal contacts.
 * Every list is paged (?limit, ?cursor) and sorted stably so a cursor walk is complete.
 */
export type Page<T> = { data: T[]; next_cursor: string | null; has_more: boolean };

type Q = URLSearchParams;
const isoDate = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const uuid = (v: string | null) => (v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null);

async function paged<T>(q: Q, fetch: (limit: number, offset: number) => PromiseLike<readonly T[]>): Promise<Page<T>> {
  const limit = pageLimit(q.get("limit")), offset = decodePageCursor(q.get("cursor"));
  const rows = [...(await fetch(limit + 1, offset))];
  const has_more = rows.length > limit;
  return { data: rows.slice(0, limit), next_cursor: has_more ? encodePageCursor(offset + limit) : null, has_more };
}

export const RESOURCES: Record<string, { scope: ApiScope; list: (tx: Tx, q: Q) => Promise<Page<unknown>> }> = {
  employees: {
    scope: "employees:read",
    list: (tx, q) => paged<Record<string, unknown>>(q, (limit, offset) => tx<Record<string, unknown>[]>`
      select e.id, e.employee_number, e.display_name, e.first_name, e.last_name, e.work_email, e.status, e.joining_date::text, e.exit_date::text, e.worker_type, e.time_type,
             e.department_id, d.name as department, e.designation_id, g.title as designation, e.location_id, l.name as location, e.manager_id,
             e.created_at, e.updated_at
      from employees e left join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id left join locations l on l.id = e.location_id
      where e.is_private = false ${q.get("status") ? tx`and e.status = ${q.get("status")}` : tx``}
        ${q.get("updated_since") ? tx`and e.updated_at >= ${q.get("updated_since")}::timestamptz` : tx``}
      order by e.created_at, e.id limit ${limit} offset ${offset}`),
  },
  departments: {
    scope: "departments:read",
    list: (tx, q) => paged<Record<string, unknown>>(q, (limit, offset) => tx<Record<string, unknown>[]>`select id, name, parent_id, business_unit_id, head_employee_id, created_at, updated_at from departments order by name, id limit ${limit} offset ${offset}`),
  },
  locations: {
    scope: "locations:read",
    list: (tx, q) => paged<Record<string, unknown>>(q, (limit, offset) => tx<Record<string, unknown>[]>`select id, name, country, state_code, timezone, address, created_at, updated_at from locations order by name, id limit ${limit} offset ${offset}`),
  },
  "leave-requests": {
    scope: "leave:read",
    list: (tx, q) => paged<Record<string, unknown>>(q, (limit, offset) => tx<Record<string, unknown>[]>`
      select r.id, r.employee_id, r.leave_type_id, t.name as leave_type, t.code as leave_type_code, r.from_date::text, r.to_date::text, r.from_half, r.to_half, r.days::float8 as days, r.status, r.created_at, r.updated_at
      from leave_requests r join leave_types t on t.id = r.leave_type_id
      where true ${uuid(q.get("employee_id")) ? tx`and r.employee_id = ${q.get("employee_id")}` : tx``}
        ${q.get("status") ? tx`and r.status = ${q.get("status")}` : tx``}
        ${isoDate(q.get("from")) ? tx`and r.to_date >= ${q.get("from")}::date` : tx``}
        ${isoDate(q.get("to")) ? tx`and r.from_date <= ${q.get("to")}::date` : tx``}
      order by r.from_date desc, r.id limit ${limit} offset ${offset}`),
  },
  attendance: {
    scope: "attendance:read",
    list: (tx, q) => paged<Record<string, unknown>>(q, (limit, offset) => tx<Record<string, unknown>[]>`
      select a.id, a.employee_id, a.date::text, a.day_type, a.status, a.first_in, a.last_out, a.gross_minutes, a.effective_minutes, a.late_minutes, a.early_minutes, a.overtime_minutes, a.shift_id, a.leave_request_id, a.updated_at
      from attendance_days a
      where true ${uuid(q.get("employee_id")) ? tx`and a.employee_id = ${q.get("employee_id")}` : tx``}
        ${isoDate(q.get("from")) ? tx`and a.date >= ${q.get("from")}::date` : tx``}
        ${isoDate(q.get("to")) ? tx`and a.date <= ${q.get("to")}::date` : tx``}
      order by a.date desc, a.id limit ${limit} offset ${offset}`),
  },
};
