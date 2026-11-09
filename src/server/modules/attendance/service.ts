import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, eachDay, todayIn, type ISODate } from "@/lib/dates";
import { sha256 } from "@/server/auth/password";
import { saveFile } from "@/server/storage";
import { notifyEmployee, startApproval } from "@/server/modules/approvals/service";
import { attendanceDateOf, checkPunch, dayWindow, normalizeIp, timingFor, type DayType } from "./rules";
import { calendarFor, capturePolicyFor, personFor, processAttendance, shiftsFor, type StoredPenalty } from "./process";
import { describe, onAttendanceRequestDecided } from "./requests";

export { recomputeDay, processAttendance } from "./process";

export type TodayState = {
  computedAt: string; date: ISODate; clockedIn: boolean; since: string | null; firstIn: string | null; workedSeconds: number;
  shift: { name: string; start: string; end: string } | null; dayType: string;
  /** hints for the clock card; the server re-checks everything on punch */
  capture: { commentRequired: boolean; remoteToday: "wfh" | "on_duty" | null; locationCapture: boolean; webEnabled: boolean; selfie: boolean; firstClockInApproval: boolean; accuracyM: number | null };
  /** a location clock-in from a new device that is still waiting for the manager */
  pendingClockIn: { at: string; requestId: string | null } | null;
};

async function remoteOn(tx: Tx, employeeId: string, date: ISODate) {
  const [r] = await tx<{ kind: "wfh" | "on_duty" }[]>`
    select kind from attendance_requests where employee_id = ${employeeId} and status = 'approved' and kind in ('wfh','on_duty')
      and from_date <= ${date} and to_date >= ${date} limit 1`;
  return r?.kind ?? null;
}

/** Where someone stands right now: which attendance day it is (night shifts!), punches so far, shift, capture hints. */
export async function today(tx: Tx, employeeId: string): Promise<TodayState> {
  const now = new Date();
  const person = await personFor(tx, employeeId);
  const tz = person?.tz ?? "Asia/Kolkata";
  const local = todayIn(tz, now);
  const shiftOn = await shiftsFor(tx, employeeId, addDaysISO(local, -1), addDaysISO(local, 2));
  const date = attendanceDateOf(now, tz, shiftOn);
  const w = dayWindow(date, shiftOn(date), shiftOn(addDaysISO(date, 1)), tz);
  const punches = await tx<{ at: Date }[]>`
    select at from punches where employee_id = ${employeeId} and status = 'valid' and source <> 'regularization' and at >= ${w.start} and at < ${w.end} order by at`;
  let worked = 0;
  for (let i = 0; i < punches.length; i += 2) worked += ((punches[i + 1]?.at.getTime() ?? now.getTime()) - punches[i].at.getTime()) / 1000;
  const shift = shiftOn(date);
  const t = timingFor(shift, date);
  const typeOn = await calendarFor(tx, employeeId, date, date);
  const cap = await capturePolicyFor(tx, employeeId);
  const [pending] = await tx<{ at: Date; request_id: string | null }[]>`
    select p.at, (select r.id from attendance_requests r where r.kind = 'remote_clock_in' and r.status = 'pending' and r.payload->>'punchId' = p.id::text limit 1) as request_id
    from punches p where p.employee_id = ${employeeId} and p.status = 'pending_approval' and p.at >= ${w.start} and p.at < ${w.end} order by p.at desc limit 1`;
  return {
    computedAt: now.toISOString(), date,
    clockedIn: punches.length % 2 === 1,
    since: punches.length % 2 === 1 ? punches[punches.length - 1].at.toISOString() : null,
    firstIn: punches[0]?.at.toISOString() ?? null,
    workedSeconds: Math.floor(worked),
    shift: shift && t ? { name: shift.name, start: t.start, end: t.end } : null,
    dayType: typeOn(date),
    capture: {
      commentRequired: !!cap.policy.web.comment_required, remoteToday: await remoteOn(tx, employeeId, date),
      locationCapture: cap.policy.mobile.enabled && cap.fences.length > 0, webEnabled: cap.policy.web.enabled,
      selfie: !!cap.policy.mobile.selfie && cap.policy.mobile.enabled && cap.fences.length > 0,
      firstClockInApproval: !!cap.policy.mobile.first_clock_in_approval && cap.policy.mobile.enabled && cap.fences.length > 0,
      accuracyM: cap.policy.mobile.accuracy_m ?? null,
    },
    pendingClockIn: pending ? { at: pending.at.toISOString(), requestId: pending.request_id } : null,
  };
}

export type PunchMeta = {
  ip: string | null; lat?: number | null; lng?: number | null; accuracy?: number | null; comment?: string | null; expect: "in" | "out";
  /** how old the browser's position fix was when sent (ms); a cached last-known position is refused */
  fixAgeMs?: number | null;
  /** JPEG data URL from the clock card's camera, when the policy asks for a selfie */
  selfie?: string | null;
  /** the browser's random clock-in id (kept in its storage) and a short label like "Chrome on Android" */
  deviceKey?: string | null; deviceLabel?: string | null;
};

const SELFIE_MAX = 1_500_000;   // bytes of JPEG; the clock card sends ~640 px at 0.7 quality (≈60 KB)

/** A JPEG data URL from the clock card → bytes, or an error the person can act on. */
function decodeSelfie(dataUrl: string | null | undefined): Uint8Array | null {
  if (!dataUrl) return null;
  const m = dataUrl.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new AppError("invalid", "The selfie didn't come through. Take it again.", "selfie");
  const bytes = Buffer.from(m[1], "base64");
  if (bytes.byteLength < 500 || bytes.byteLength > SELFIE_MAX) throw new AppError("invalid", "The selfie didn't come through. Take it again.", "selfie");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new AppError("invalid", "The selfie must be a JPEG photo from the camera.", "selfie");
  return new Uint8Array(bytes);
}

/**
 * Clock in or out (alternates). The capture policy is enforced here, not in the browser: office IP allowlist,
 * or a location inside a geofence, or anywhere on an approved WFH / on-duty day.
 * Location clock-ins may also need a selfie (stored, shown to HR; never matched against anything) and, from a browser the
 * person hasn't used at that location before, the manager's approval: the punch waits as 'pending_approval' behind an
 * attendance request of kind 'remote_clock_in' until then.
 * Errors that the clock card can fix carry a field: "location" (ask for location), "comment" or "selfie".
 */
export async function punch(tx: Tx, actor: Actor, meta: PunchMeta) {
  await tx`select pg_advisory_xact_lock(hashtext(${"punch:" + actor.employeeId}))`;
  const state = await today(tx, actor.employeeId);
  if (state.pendingClockIn) throw new AppError("conflict", "Your clock-in from this new device is still waiting for your manager. Once it's approved you can clock out.");
  if ((meta.expect === "in") === state.clockedIn) throw new AppError("conflict", state.clockedIn ? "You're already clocked in." : "You're already clocked out.");
  const cap = await capturePolicyFor(tx, actor.employeeId);
  const ip = normalizeIp(meta.ip);
  const lat = meta.lat != null && Number.isFinite(meta.lat) && Math.abs(meta.lat) <= 90 ? meta.lat : null;
  const lng = meta.lng != null && Number.isFinite(meta.lng) && Math.abs(meta.lng) <= 180 ? meta.lng : null;
  const accuracy = meta.accuracy != null && Number.isFinite(meta.accuracy) && meta.accuracy >= 0 ? Math.min(meta.accuracy, 100000) : null;
  const fixAgeMs = meta.fixAgeMs != null && Number.isFinite(meta.fixAgeMs) ? Math.max(0, meta.fixAgeMs) : null;
  const selfie = decodeSelfie(meta.selfie);
  const check = checkPunch(cap.policy, cap.fences, { ip, lat, lng, accuracy, fixAgeMs, hasSelfie: !!selfie, comment: meta.comment, remoteToday: !!state.capture.remoteToday });
  if (!check.ok) {
    const field = ["location_needed", "outside", "accuracy", "stale"].includes(check.code) ? "location" : check.code === "comment" ? "comment" : check.code === "selfie" ? "selfie" : undefined;
    throw new AppError("invalid", check.message, field);
  }
  // selfies are kept only for location clock-ins under a policy that asks for them
  const selfieFileId = check.source === "mobile" && cap.policy.mobile.selfie && selfie
    ? await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: `clock-in selfie ${state.date}.jpg`, mime: "image/jpeg", bytes: selfie, ext: "jpg" })
    : null;
  // first clock-in from a browser the person hasn't used at this location: wait for the manager
  const deviceHash = meta.deviceKey && /^[A-Za-z0-9_-]{16,64}$/.test(meta.deviceKey) ? sha256(`clock-in:${actor.employeeId}:${meta.deviceKey}`) : null;
  const deviceLabel = meta.deviceLabel?.trim().slice(0, 80) || null;
  let needsApproval = false;
  if (check.source === "mobile" && cap.policy.mobile.first_clock_in_approval && meta.expect === "in") {
    const [trusted] = deviceHash ? await tx`select 1 from clock_in_trust where employee_id = ${actor.employeeId} and device_hash = ${deviceHash} and geofence_id is not distinct from ${check.fenceId}` : [];
    needsApproval = !trusted;
  }
  const [p] = await tx<{ id: string; at: Date }[]>`
    insert into punches (tenant_id, employee_id, at, direction, source, ip, lat, lng, accuracy_m, comment, selfie_file_id, status)
    values (${actor.tenant.id}, ${actor.employeeId}, now(), ${meta.expect}, ${check.source}, ${ip}, ${lat}, ${lng}, ${accuracy}, ${meta.comment?.trim().slice(0, 500) || null}, ${selfieFileId}, ${needsApproval ? "pending_approval" : "valid"})
    returning id, at`;
  if (needsApproval) {
    const payload = { punchId: p.id, deviceHash, deviceLabel, fenceId: check.fenceId, fence: check.fence, lat, lng, accuracy, selfieFileId, at: p.at.toISOString() };
    const [r] = await tx<{ id: string }[]>`
      insert into attendance_requests (tenant_id, employee_id, kind, from_date, to_date, payload, reason)
      values (${actor.tenant.id}, ${actor.employeeId}, 'remote_clock_in', ${state.date}, ${state.date}, ${tx.json(payload)}, ${`First clock-in from ${deviceLabel ?? "a new device"} at ${check.fence ?? "a location"}`}) returning id`;
    const { status } = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "attendance_request", entityId: r.id, requesterId: actor.employeeId, summary: `${actor.name} · ${describe("remote_clock_in", state.date, state.date, payload)}` });
    if (status === "approved") await onAttendanceRequestDecided(tx, actor, r.id, "approved");   // nobody to ask: counts at once
    else {
      await notifyEmployee(tx, actor.tenant.id, actor.employeeId, "attendance.clock_in_review", "Your clock-in is waiting for approval",
        `First clock-in from ${deviceLabel ?? "this device"} at ${check.fence ?? "this location"}. It counts once your manager approves it.`, "/me/attendance");
      return { at: p.at.toISOString(), direction: meta.expect, fence: check.fence, pendingApproval: true as const };
    }
  }
  await processAttendance(tx, actor.tenant.id, actor.employeeId, state.date);
  return { at: p.at.toISOString(), direction: meta.expect, fence: check.source === "mobile" ? check.fence : null, pendingApproval: false as const };
}

export type LogRow = {
  date: ISODate; dayType: string; status: string; firstIn: string | null; lastOut: string | null; gross: number; effective: number; late: number; early: number;
  leave: string | null; shift: string | null; penalties: StoredPenalty[]; missingSwipe: boolean; regularized: boolean;
  overtime: number;
  requests: { kind: string; status: string }[];
};

type DayRow = { employee_id: string; date: string; status: string; day_type: string; first_in: Date | null; last_out: Date | null; gross_minutes: number; effective_minutes: number; late_minutes: number; early_minutes: number; penalties: StoredPenalty[]; shift: string | null; overtime_minutes: number };

/**
 * Day-by-day statuses for people over a date range, falling back to the calendar and approved leave for days
 * that haven't been processed. Shared by the personal log and the team grid.
 */
export async function statuses(tx: Tx, employeeIds: string[], from: ISODate, to: ISODate, today: ISODate) {
  if (!employeeIds.length) return new Map<string, Map<ISODate, LogRow>>();
  const [days, leaves, people, reqs, regs] = await Promise.all([
    tx<DayRow[]>`
      select a.employee_id, a.date::text, a.status, a.day_type, a.first_in, a.last_out, a.gross_minutes, a.effective_minutes, a.late_minutes, a.early_minutes, a.penalties, s.name as shift, a.overtime_minutes
      from attendance_days a left join shifts s on s.id = a.shift_id
      where a.employee_id = any(${employeeIds}::uuid[]) and a.date between ${from} and ${to}`,
    tx<{ employee_id: string; from_date: string; to_date: string; from_half: string; to_half: string; name: string }[]>`
      select q.employee_id, q.from_date::text, q.to_date::text, q.from_half, q.to_half, t.name from leave_requests q join leave_types t on t.id = q.leave_type_id
      where q.employee_id = any(${employeeIds}::uuid[]) and q.status = 'approved' and q.to_date >= ${from} and q.from_date <= ${to}`,
    tx<{ id: string; joining_date: string; exit_date: string | null }[]>`select id, joining_date::text, exit_date::text from employees where id = any(${employeeIds}::uuid[])`,
    tx<{ employee_id: string; kind: string; status: string; from_date: string; to_date: string }[]>`
      select employee_id, kind, status, from_date::text, to_date::text from attendance_requests
      where employee_id = any(${employeeIds}::uuid[]) and status in ('pending','approved') and to_date >= ${from} and from_date <= ${to}`,
    tx<{ employee_id: string; date: string }[]>`
      select distinct a.employee_id, a.date::text from attendance_days a join attendance_requests r
        on r.employee_id = a.employee_id and r.kind = 'regularization' and r.status = 'approved' and r.from_date = a.date
      where a.employee_id = any(${employeeIds}::uuid[]) and a.date between ${from} and ${to}`,
  ]);
  const out = new Map<string, Map<ISODate, LogRow>>();
  const regSet = new Set(regs.map((r) => `${r.employee_id}:${r.date}`));
  for (const p of people) {
    const cal = await calendarFor(tx, p.id, from, to);
    const mine = new Map(days.filter((d) => d.employee_id === p.id).map((d) => [d.date, d]));
    const m = new Map<ISODate, LogRow>();
    for (const date of eachDay(from, to)) {
      const d = mine.get(date);
      const lv = leaves.find((l) => l.employee_id === p.id && date >= l.from_date && date <= l.to_date);
      const type: DayType = (d?.day_type as DayType) ?? cal(date);
      const half = lv && ((date === lv.from_date && lv.from_half === "second") || (date === lv.to_date && lv.to_half === "first"));
      const status = date < p.joining_date || (p.exit_date && date > p.exit_date) ? "not_joined"
        : d?.status ?? (date > today ? (lv && type === "working" ? (half ? "half_leave" : "leave") : type === "working" ? "upcoming" : type)
          : lv && type === "working" ? (half ? "half_leave" : "leave") : type === "working" ? (date === today ? "today" : "absent") : type);
      m.set(date, {
        date, dayType: type, status: date === today && status === "absent" ? "today" : status,
        firstIn: d?.first_in?.toISOString() ?? null, lastOut: d?.last_out?.toISOString() ?? null,
        gross: d?.gross_minutes ?? 0, effective: d?.effective_minutes ?? 0, late: d?.late_minutes ?? 0, early: d?.early_minutes ?? 0,
        leave: lv?.name ?? null, shift: d?.shift ?? null, penalties: d?.penalties ?? [],
        missingSwipe: !!d && d.status !== "absent" && !!d.first_in && !d.last_out && date < today,
        regularized: regSet.has(`${p.id}:${date}`),
        overtime: d?.overtime_minutes ?? 0,
        requests: reqs.filter((r) => r.employee_id === p.id && date >= r.from_date && date <= r.to_date).map((r) => ({ kind: r.kind, status: r.status })),
      });
    }
    out.set(p.id, m);
  }
  return out;
}

export async function monthLog(tx: Tx, employeeId: string, month: ISODate /* YYYY-MM-01 */): Promise<LogRow[]> {
  const person = await personFor(tx, employeeId);
  const t = todayIn(person?.tz ?? "Asia/Kolkata");
  const first = `${month.slice(0, 7)}-01`;
  const last = addDaysISO(addDaysISO(first, 32).slice(0, 8) + "01", -1);
  const end = last < t ? last : t;
  if (end < first) return [];
  const m = (await statuses(tx, [employeeId], first, end, t)).get(employeeId);
  return m ? [...m.values()].reverse() : [];
}
