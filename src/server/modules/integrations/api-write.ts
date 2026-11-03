import "server-only";
import { randomUUID } from "node:crypto";
import { AppError, type Tx } from "@/server/db";
import type { Tenant } from "@/server/auth/session";
import { actorForEmployee } from "@/server/auth/system-actor";
import { encryptField } from "@/server/modules/payroll/secret";
import { apply as applyLeave } from "@/server/modules/leave/service";
import { processAttendance } from "@/server/modules/attendance/process";
import { addDaysISO, todayIn } from "@/lib/dates";
import { ALL_EVENTS, endpointUrlProblem, isEvent, type ApiScope } from "./rules";
import type { ApiPrincipal } from "./oauth";

/*
 * Public API v1 writes and Zapier-style hooks (plat2). Every write runs as the person it concerns (same rules as
 * the app: balances, approvals, policies), so an integration can never do more than that person could.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export class ApiProblem extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function employeeByRef(tx: Tx, ref: unknown) {
  const r = str(ref);
  if (!r) throw new ApiProblem(400, "invalid_request", "employee_id (uuid) or employee_number is required.");
  const [e] = await tx<{ id: string }[]>`select id from employees where status in ('active','notice') and (${UUID.test(r) ? tx`id = ${r}` : tx`employee_number = ${r}`})`;
  if (!e) throw new ApiProblem(404, "not_found", "No active employee matches employee_id / employee_number.");
  return e.id;
}

/** POST /api/v1/leave-requests → a normal leave request for that person (goes through their approval chain). */
export async function createLeaveRequest(tx: Tx, tenant: Tenant, body: Record<string, unknown>) {
  const employeeId = await employeeByRef(tx, body.employee_id ?? body.employee_number);
  const actor = await actorForEmployee(tx, tenant, employeeId);
  if (!actor) throw new ApiProblem(409, "no_account", "This person has no active sign-in, so a request can't be raised for them.");
  const from = str(body.from), to = str(body.to ?? body.from);
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) throw new ApiProblem(400, "invalid_request", "from and to must be dates (YYYY-MM-DD).");
  let typeId = str(body.leave_type_id);
  if (!typeId) {
    const code = str(body.leave_type_code);
    if (!code) throw new ApiProblem(400, "invalid_request", "leave_type_id or leave_type_code is required.");
    const [t] = await tx<{ id: string }[]>`select id from leave_types where code = ${code.toUpperCase()}`;
    if (!t) throw new ApiProblem(404, "not_found", `Unknown leave_type_code ${code}.`);
    typeId = t.id;
  } else if (!UUID.test(typeId)) throw new ApiProblem(400, "invalid_request", "leave_type_id must be a uuid.");
  const part = (v: unknown): "full" | "first" | "second" => (v === "first_half" || v === "first" ? "first" : v === "second_half" || v === "second" ? "second" : "full");
  try {
    const r = await applyLeave(tx, actor, { leaveTypeId: typeId, from, to, fromPart: part(body.from_part), toPart: part(body.to_part), note: str(body.note).slice(0, 1000) || undefined });
    return { id: r.id, status: r.status, days: r.days, employee_id: employeeId };
  } catch (e) {
    if (e instanceof AppError) throw new ApiProblem(e.code === "invalid" ? 422 : 409, e.code, e.message);
    throw e;
  }
}

/** POST /api/v1/attendance/punches → one punch (source "api"), idempotent by external_id per person. */
export async function createPunch(tx: Tx, tenant: Tenant, body: Record<string, unknown>, now = new Date()) {
  const employeeId = await employeeByRef(tx, body.employee_id ?? body.employee_number);
  const at = new Date(str(body.at));
  if (Number.isNaN(at.getTime())) throw new ApiProblem(400, "invalid_request", "at must be an ISO 8601 timestamp.");
  if (at.getTime() > now.getTime() + 5 * 60_000 || at.getTime() < now.getTime() - 45 * 864e5) throw new ApiProblem(422, "out_of_range", "at must be within the last 45 days and not in the future.");
  const direction = body.direction === "in" || body.direction === "out" ? body.direction : "auto";
  const externalId = str(body.external_id).slice(0, 120) || null;
  const r = await tx`insert into punches (tenant_id, employee_id, at, direction, source, client_id, comment) values (${tenant.id}, ${employeeId}, ${at}, ${direction}, 'api', ${externalId}, ${str(body.comment).slice(0, 500) || null}) on conflict (employee_id, client_id) where client_id is not null do nothing`;
  const duplicate = !r.count;
  const date = todayIn("Asia/Kolkata", at);
  if (!duplicate) for (const d of [addDaysISO(date, -1), date]) await processAttendance(tx, tenant.id, employeeId, d, { now });
  return { employee_id: employeeId, at: at.toISOString(), direction, duplicate };
}

// ---------------------------------------------------------------- REST hooks (Zapier)

export type HookRow = { id: string; event: string; target_url: string; created_at: string };

export async function listHooks(tx: Tx, principal: ApiPrincipal): Promise<HookRow[]> {
  const rows = await tx<{ id: string; events: string[]; url: string; created_at: Date }[]>`select id, events, url, created_at from webhook_endpoints where kind = 'rest_hook' and owner_ref = ${principal.ref} order by created_at`;
  return rows.map((r) => ({ id: r.id, event: r.events[0], target_url: r.url, created_at: r.created_at.toISOString() }));
}

/** Subscribe: one hook per (event, target URL) for this key / client. Returns the signing secret once. */
export async function subscribeHook(tx: Tx, tenant: Tenant, principal: ApiPrincipal, body: Record<string, unknown>) {
  const event = str(body.event), url = str(body.target_url ?? body.hookUrl);
  if (!isEvent(event) || event === "test.ping") throw new ApiProblem(400, "invalid_request", `event must be one of: ${ALL_EVENTS.filter((e) => e !== "test.ping").join(", ")}.`);
  const problem = endpointUrlProblem(url, (process.env.ROOT_DOMAIN ?? "").split(":")[0] || null);
  if (problem) throw new ApiProblem(400, "invalid_request", `target_url: ${problem}`);
  const [existing] = await tx<{ id: string }[]>`select id from webhook_endpoints where kind = 'rest_hook' and owner_ref = ${principal.ref} and url = ${url} and events = ${[event]}::text[]`;
  if (existing) return { id: existing.id, event, target_url: url, secret: null, existing: true };
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from webhook_endpoints where kind = 'rest_hook' and owner_ref = ${principal.ref}`;
  if (n >= 25) throw new ApiProblem(429, "too_many_hooks", "At most 25 hooks per key or client. Unsubscribe one first.");
  const id = randomUUID(), secret = `whsec_${randomUUID().replace(/-/g, "")}`;
  await tx`insert into webhook_endpoints (id, tenant_id, url, events, secret_enc, is_active, kind, owner_ref, label) values (${id}, ${tenant.id}, ${url}, ${[event]}, ${encryptField(secret, [tenant.id, "webhook", id])}, true, 'rest_hook', ${principal.ref}, ${`REST hook (${principal.kind === "api_key" ? "API key" : "OAuth client"})`})`;
  return { id, event, target_url: url, secret, existing: false };
}

export async function unsubscribeHook(tx: Tx, principal: ApiPrincipal, id: string) {
  if (!UUID.test(id)) throw new ApiProblem(404, "not_found", "No such hook.");
  const r = await tx`delete from webhook_endpoints where id = ${id} and kind = 'rest_hook' and owner_ref = ${principal.ref}`;
  if (!r.count) throw new ApiProblem(404, "not_found", "No such hook.");
}

/** Sample payloads, so a Zap can be built before any real event fires. */
export function samplePayload(event: string) {
  const base = { id: "7a1c2d3e-0000-4000-8000-000000000001", created_at: "2026-11-03T09:30:00.000Z" };
  const data: Record<string, unknown> = {
    "approval.decided": { entity_type: "leave", entity_id: "9b2e…", request_id: "1f3a…", requester_employee_id: "e1…", decision: "approved", decided_by_employee_id: "m1…", summary: "Casual leave · 12 Nov – 13 Nov (2 days)" },
    "employee.created": { employee_id: "e1…", employee_number: "EMP0042", joining_date: "2026-12-01" },
    "employee.exited": { employee_id: "e1…", exit_id: "x1…", last_working_date: "2026-11-30" },
    "payroll.finalized": { run_id: "r1…", pay_group_id: "g1…", period_month: "2026-10-01", people: 42 },
    "leave.approved": { leave_request_id: "9b2e…", employee_id: "e1…", leave_type_code: "CL", from: "2026-11-12", to: "2026-11-13", days: 2 },
  };
  return { ...base, type: event, data: data[event] ?? {} };
}

/** Polling triggers: the newest items for an event, newest first, each with a stable id (Zapier dedupes on id). */
export async function pollTrigger(tx: Tx, event: string, limit = 25): Promise<Record<string, unknown>[]> {
  const n = Math.min(Math.max(1, limit), 100);
  switch (event) {
    case "employee.created":
      return tx<Record<string, unknown>[]>`select id, employee_number, display_name, work_email, joining_date::text, department_id, designation_id, created_at from employees where is_private = false order by created_at desc, id limit ${n}`;
    case "employee.exited":
      return tx<Record<string, unknown>[]>`select id, employee_number, display_name, exit_date::text, updated_at from employees where status = 'relieved' order by exit_date desc nulls last, id limit ${n}`;
    case "leave.approved":
      return tx<Record<string, unknown>[]>`select r.id, r.employee_id, t.code as leave_type_code, r.from_date::text as "from", r.to_date::text as "to", r.days::float8 as days, r.updated_at from leave_requests r join leave_types t on t.id = r.leave_type_id where r.status = 'approved' order by r.updated_at desc, r.id limit ${n}`;
    case "approval.decided":
      return tx<Record<string, unknown>[]>`select id, entity_type, entity_id, requester_employee_id, summary, status as decision, updated_at from approval_requests where status in ('approved','rejected') order by updated_at desc, id limit ${n}`;
    case "payroll.finalized":
      return tx<Record<string, unknown>[]>`select id, pay_group_id, period_month::text, status, updated_at from payroll_runs where status in ('finalized','payslips_released','paid') order by updated_at desc, id limit ${n}`;
    default:
      throw new ApiProblem(404, "not_found", `No polling trigger for ${event}.`);
  }
}

export const WRITE_SCOPES: Record<string, ApiScope> = { "leave-requests": "leave:write", "attendance/punches": "attendance:write", hooks: "hooks:write" };
