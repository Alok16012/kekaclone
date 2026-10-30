import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { todayIn, type ISODate } from "@/lib/dates";
import { cancelApproval, startApproval } from "@/server/modules/approvals/service";
import { dayType } from "./rules";
import { validateCompOff } from "./accrual-rules";
import { onCompOffDecided } from "./effects";
import { calendarFor, fmtRange } from "./service";

export type CompOffSettings = { typeId: string; typeName: string; expiryDays: number | null; windowDays: number };

/** The comp-off leave type in the person's plan, with its claim window and expiry; null when the plan has none. */
export async function compOffSettings(tx: Tx, employeeId: string): Promise<CompOffSettings | null> {
  const [t] = await tx<{ id: string; name: string; application: { compOffExpiryDays?: number; compOffWindowDays?: number } }[]>`
    select t.id, t.name, r.application from employees e join leave_plan_rules r on r.leave_plan_id = e.leave_plan_id
    join leave_types t on t.id = r.leave_type_id and t.kind = 'comp_off' where e.id = ${employeeId} order by t.created_at limit 1`;
  if (!t) return null;
  return { typeId: t.id, typeName: t.name, expiryDays: t.application?.compOffExpiryDays || null, windowDays: t.application?.compOffWindowDays ?? 30 };
}

const fmtDates = (ds: string[]) => ds.map((d) => fmtRange(d, d)).join(", ");

/** Claim comp-off for weekly offs / holidays worked. Each day worked earns one day. Goes to the approvals engine as 'comp_off'. */
export async function requestCompOff(tx: Tx, actor: Actor, input: { dates: ISODate[]; note?: string }) {
  const employeeId = actor.employeeId;
  const s = await compOffSettings(tx, employeeId);
  if (!s) throw new AppError("invalid", "Your leave plan doesn't include comp-off. Ask HR if you think it should.");
  await tx`select pg_advisory_xact_lock(hashtext(${"comp_off:" + employeeId}))`;
  const dates = [...input.dates].sort();
  const cal = await calendarFor(tx, employeeId);
  const claimed = await tx<{ d: string }[]>`
    select unnest(worked_dates)::text as d from comp_off_requests where employee_id = ${employeeId} and status in ('pending', 'approved')`;
  const v = validateCompOff({ dates, today: todayIn(), windowDays: s.windowDays, dayTypes: Object.fromEntries(dates.map((d) => [d, dayType(d, cal)])), claimed: new Set(claimed.map((c) => c.d)) });
  if (v.length) throw new AppError("invalid", v[0].message, "dates");
  const [{ id }] = await tx<{ id: string }[]>`
    insert into comp_off_requests (tenant_id, employee_id, worked_dates, days, note) values (${actor.tenant.id}, ${employeeId}, ${dates}::date[], ${dates.length}, ${input.note || null}) returning id`;
  const [who] = await tx<{ display_name: string }[]>`select display_name from employees where id = ${employeeId}`;
  const summary = `${who.display_name} · Comp-off · worked ${fmtDates(dates)} · ${dates.length} ${dates.length === 1 ? "day" : "days"}`;
  const { status } = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "comp_off", entityId: id, requesterId: employeeId, summary });
  if (status === "approved") await onCompOffDecided(tx, actor, id, "approved");
  return { id, status };
}

export async function cancelCompOff(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx<{ employee_id: string; status: string }[]>`select employee_id, status from comp_off_requests where id = ${id} for update`;
  if (!r || r.employee_id !== actor.employeeId) throw new AppError("not_found", "Comp-off request not found.");
  if (r.status !== "pending") throw new AppError("invalid", "Only pending comp-off requests can be withdrawn.");
  await cancelApproval(tx, "comp_off", id);
  await tx`update comp_off_requests set status = 'cancelled', updated_at = now() where id = ${id}`;
}

export type CompOffRow = { id: string; worked_dates: string[]; days: string; note: string | null; status: "pending" | "approved" | "rejected" | "cancelled"; expires_on: string | null; expired: boolean; created_at: Date };

export async function myCompOffs(tx: Tx, employeeId: string) {
  return tx<CompOffRow[]>`
    select q.id, q.worked_dates::text[], q.days, q.note, q.status, q.expires_on::text, q.created_at,
      exists (select 1 from leave_ledger l where l.idempotency_key = 'expiry:' || q.id::text and l.amount < 0) as expired
    from comp_off_requests q where q.employee_id = ${employeeId} order by q.created_at desc limit 50`;
}

/** For the approver's drawer: the claim, what each date was for the person, and whether they clocked in. */
export async function compOffDetail(tx: Tx, id: string) {
  const [r] = await tx<(CompOffRow & { employee_id: string; employee: string })[]>`
    select q.id, q.worked_dates::text[], q.days, q.note, q.status, q.expires_on::text, q.created_at, false as expired, q.employee_id, e.display_name as employee
    from comp_off_requests q join employees e on e.id = q.employee_id where q.id = ${id}`;
  if (!r) return null;
  const cal = await calendarFor(tx, r.employee_id);
  const punched = new Set((await tx<{ d: string }[]>`
    select distinct (at at time zone 'Asia/Kolkata')::date::text as d from punches
    where employee_id = ${r.employee_id} and (at at time zone 'Asia/Kolkata')::date = any(${r.worked_dates}::date[])`).map((x) => x.d));
  return { ...r, days: Number(r.days), dates: r.worked_dates.map((d) => ({ date: d, dayType: dayType(d, cal), clockedIn: punched.has(d) })) };
}
