import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { sha256 } from "@/server/auth/password";
import { addDaysISO, type ISODate } from "@/lib/dates";
import { canManagePolicies } from "./policies";
import { formatDeviceKey, parseDeviceKey, validateDevice, type PunchItem } from "./device-rules";
import { attendanceDateOf } from "./rules";
import { personFor, processAttendance, shiftsFor } from "./process";

/**
 * Biometric devices: each one has its own API key (shown once, stored hashed). Punches arrive in batches on
 * POST /api/v1/punches and are idempotent by (device, external id). Managing devices is company-wide: attendance.admin
 * without a scope.
 */

const assertPolicies = (actor: Actor) => { if (!canManagePolicies(actor)) throw new AppError("forbidden", "You don't have access to manage devices."); };
async function audit(tx: Tx, actor: Actor, id: string, action: string, diff: unknown) {
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'device', ${id}, ${action}, ${tx.json(diff as never)})`;
}

export type DeviceRow = { id: string; name: string; vendor: string; serial: string; location: string | null; location_id: string | null; last_seen_at: string | null; last_seen_ago: string; online: boolean; punches_today: number; punches_total: number; created_at: string };

const ago = (d: Date, now: Date) => {
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} days ago`;
};

export async function listDevices(tx: Tx, today: ISODate): Promise<DeviceRow[]> {
  const rows = await tx<(Omit<DeviceRow, "last_seen_at" | "created_at" | "last_seen_ago" | "online"> & { last_seen_at: Date | null; created_at: Date })[]>`
    select d.id, d.name, d.vendor, d.serial, l.name as location, d.location_id, d.last_seen_at, d.created_at,
      (select count(*)::int from punches p where p.device_id = d.id and p.at >= (${today}::date)::timestamp at time zone 'Asia/Kolkata') as punches_today,
      (select count(*)::int from punches p where p.device_id = d.id) as punches_total
    from devices d left join locations l on l.id = d.location_id order by d.created_at, d.id`;
  const now = new Date();
  return rows.map((r) => ({
    ...r, last_seen_at: r.last_seen_at?.toISOString() ?? null, created_at: r.created_at.toISOString(),
    last_seen_ago: r.last_seen_at ? ago(r.last_seen_at, now) : "never", online: !!r.last_seen_at && now.getTime() - r.last_seen_at.getTime() < 36e5,
  }));
}

const newSecret = () => randomBytes(32).toString("base64url");

/** Adds a device and returns its key once. The key is never readable again; rotate it if it's lost. */
export async function createDevice(tx: Tx, actor: Actor, input: { name: string; serial: string; vendor: string; locationId: string | null }) {
  assertPolicies(actor);
  const err = validateDevice(input);
  if (err) throw new AppError("invalid", err);
  if (input.locationId) {
    const [l] = await tx`select 1 from locations where id = ${input.locationId}`;
    if (!l) throw new AppError("not_found", "That location no longer exists.");
  }
  const secret = newSecret();
  let row: { id: string }[];
  try {
    row = await tx.savepoint((sp) => sp<{ id: string }[]>`
      insert into devices (tenant_id, location_id, name, vendor, serial, api_key_hash) values (${actor.tenant.id}, ${input.locationId}, ${input.name.trim()}, ${input.vendor}, ${input.serial.trim()}, ${sha256(secret)}) returning id`) as { id: string }[];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", "A device with this serial number already exists.", "serial");
    throw e;
  }
  await audit(tx, actor, row[0].id, "create", { name: input.name.trim(), serial: input.serial.trim(), vendor: input.vendor });
  return { id: row[0].id, key: formatDeviceKey(row[0].id, secret) };
}

export async function updateDevice(tx: Tx, actor: Actor, id: string, input: { name: string; vendor: string; locationId: string | null }) {
  assertPolicies(actor);
  const [d] = await tx<{ serial: string }[]>`select serial from devices where id = ${id}`;
  if (!d) throw new AppError("not_found", "This device no longer exists.");
  const err = validateDevice({ ...input, serial: d.serial });
  if (err) throw new AppError("invalid", err);
  if (input.locationId) {
    const [l] = await tx`select 1 from locations where id = ${input.locationId}`;
    if (!l) throw new AppError("not_found", "That location no longer exists.");
  }
  await tx`update devices set name = ${input.name.trim()}, vendor = ${input.vendor}, location_id = ${input.locationId} where id = ${id}`;
  await audit(tx, actor, id, "update", input);
}

/** New key for a device that lost or leaked its old one. The old key stops working at once. */
export async function rotateDeviceKey(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  const secret = newSecret();
  const r = await tx`update devices set api_key_hash = ${sha256(secret)} where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "This device no longer exists.");
  await audit(tx, actor, id, "rotate_key", {});
  return { key: formatDeviceKey(id, secret) };
}

export async function deleteDevice(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  const r = await tx`delete from devices where id = ${id}`;   // its punches stay (device_id set null)
  if (!r.count) throw new AppError("not_found", "This device no longer exists.");
  await audit(tx, actor, id, "delete", {});
}

export type AuthedDevice = { id: string; name: string; tenant_id: string };

/** The device behind a raw key, or null. Runs inside the tenant resolved from the subdomain, so keys can't cross tenants. */
export async function authenticateDevice(tx: Tx, rawKey: string | null | undefined): Promise<AuthedDevice | null> {
  const parsed = parseDeviceKey(rawKey);
  if (!parsed) return null;
  const [d] = await tx<{ id: string; name: string; tenant_id: string; api_key_hash: string }[]>`select id, name, tenant_id, api_key_hash from devices where id = ${parsed.deviceId}`;
  if (!d) return null;
  const a = Buffer.from(d.api_key_hash, "utf8"), b = Buffer.from(sha256(parsed.secret), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { id: d.id, name: d.name, tenant_id: d.tenant_id };
}

export type IngestResult = { accepted: number; duplicates: number; unknown: string[]; rejected: { external_id: string; reason: string }[]; processedDays: number };

/**
 * Stores a validated batch for a device. Employees are matched by attendance number or employee number; unknown ones
 * are reported, not failed. Idempotent by (device, external id). Every affected attendance day is re-processed.
 */
export async function ingestPunches(tx: Tx, device: AuthedDevice, items: PunchItem[], now = new Date()): Promise<IngestResult> {
  const refs = [...new Set(items.map((i) => i.employee))];
  const people = await tx<{ id: string; attendance_number: string | null; employee_number: string }[]>`
    select id, attendance_number, employee_number from employees
    where status <> 'relieved' and (attendance_number = any(${refs}::text[]) or employee_number = any(${refs}::text[]))`;
  const byRef = new Map<string, string>();
  for (const p of people) { if (p.attendance_number) byRef.set(p.attendance_number, p.id); byRef.set(p.employee_number, p.id); }
  const result: IngestResult = { accepted: 0, duplicates: 0, unknown: [], rejected: [], processedDays: 0 };
  const affected = new Map<string, Set<ISODate>>();
  const horizonLo = new Date(now.getTime() - 45 * 864e5), horizonHi = new Date(now.getTime() + 36e5);
  for (const i of items) {
    const employeeId = byRef.get(i.employee);
    if (!employeeId) { if (!result.unknown.includes(i.employee)) result.unknown.push(i.employee); continue; }
    const at = new Date(i.at);
    if (at < horizonLo || at > horizonHi) { result.rejected.push({ external_id: i.external_id, reason: "time is more than 45 days old or in the future" }); continue; }
    const r = await tx`insert into punches (tenant_id, employee_id, at, direction, source, device_id, external_id)
                       values (${device.tenant_id}, ${employeeId}, ${at}, ${i.direction}, 'biometric', ${device.id}, ${i.external_id})
                       on conflict (device_id, external_id) do nothing`;
    if (!r.count) { result.duplicates++; continue; }
    result.accepted++;
    const person = await personFor(tx, employeeId);
    const tz = person?.tz ?? "Asia/Kolkata";
    const local = at.toISOString().slice(0, 10);
    const shiftOn = await shiftsFor(tx, employeeId, addDaysISO(local, -2), addDaysISO(local, 2));
    const date = attendanceDateOf(at, tz, shiftOn);
    if (!affected.has(employeeId)) affected.set(employeeId, new Set());
    affected.get(employeeId)!.add(date);
  }
  for (const [employeeId, dates] of affected) for (const d of dates) { await processAttendance(tx, device.tenant_id, employeeId, d, { now }); result.processedDays++; }
  await tx`update devices set last_seen_at = ${now} where id = ${device.id}`;
  return result;
}
