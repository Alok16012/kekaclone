"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as policies from "@/server/modules/attendance/policies";

const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timing = z.object({ start: z.string().max(5), end: z.string().max(5) }).nullable();
const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const bad = { ok: false as const, error: "Check the fields and try again." };
const idOrNull = (id: string | null) => (id === null ? null : uuid.parse(id));

const shiftInput = z.object({
  name: z.string().max(80), code: z.string().max(12), kind: z.enum(["fixed", "flexible"]),
  timings: z.partialRecord(z.enum(weekdays), timing),
  break_minutes: z.number().int(), grace_minutes: z.number().int(), half_day_minutes: z.number().int().nullable(),
  auto_assign: z.object({ from: z.string().max(5), to: z.string().max(5) }).nullable().optional(),
});
export async function saveShiftAction(id: string | null, input: z.input<typeof shiftInput>) {
  const p = shiftInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => policies.saveShift(tx, actor, idOrNull(id), p.data));
}
export async function deleteShiftAction(id: string) {
  return runAction((tx, actor) => policies.deleteShift(tx, actor, uuid.parse(id)));
}

const offValue = z.enum(["off", "half", "work"]);
const weeklyOffInput = z.object({ name: z.string().max(80), grid: z.partialRecord(z.enum(weekdays), z.array(offValue).length(5)) });
export async function saveWeeklyOffAction(id: string | null, input: z.input<typeof weeklyOffInput>) {
  const p = weeklyOffInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => policies.saveWeeklyOff(tx, actor, idOrNull(id), p.data));
}
export async function deleteWeeklyOffAction(id: string) {
  return runAction((tx, actor) => policies.deleteWeeklyOff(tx, actor, uuid.parse(id)));
}

const captureInput = z.object({
  name: z.string().max(80),
  web: z.object({ enabled: z.boolean(), comment_required: z.boolean(), ip_ranges: z.array(z.string().max(60)).max(60) }),
  mobile: z.object({ enabled: z.boolean(), fences: z.array(z.object({ id: uuid.nullable().optional(), name: z.string().max(80), lat: z.number(), lng: z.number(), radius_m: z.number().int() })).max(20) }),
  remote: z.object({ wfh: z.boolean(), od: z.boolean() }),
  limits: z.object({ regularization_per_month: z.number().int(), regularization_past_days: z.number().int(), partial_day_minutes_per_month: z.number().int() }),
});
export async function saveCaptureAction(id: string | null, input: z.input<typeof captureInput>) {
  const p = captureInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => policies.saveCapture(tx, actor, idOrNull(id), p.data));
}
export async function deleteCaptureAction(id: string) {
  return runAction((tx, actor) => policies.deleteCapture(tx, actor, uuid.parse(id)));
}

const penaltyInput = z.object({
  name: z.string().max(80),
  late_arrival: z.object({ enabled: z.boolean(), grace_minutes: z.number().int().nullable().optional(), free_per_month: z.number().int(), deduct_days: z.number() }).nullable(),
  hours_shortage: z.object({ enabled: z.boolean(), basis: z.enum(["effective", "gross"]), full_day_minutes: z.number().int(), half_day_minutes: z.number().int() }).nullable(),
  no_attendance: z.object({ enabled: z.boolean() }).nullable(),
  missing_swipe: z.object({ enabled: z.boolean(), deduct_days: z.number() }).nullable(),
  deduct_from: z.array(uuid).max(5),
});
export async function savePenaltyAction(id: string | null, input: z.input<typeof penaltyInput>) {
  const p = penaltyInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => policies.savePenalty(tx, actor, idOrNull(id), p.data));
}
export async function deletePenaltyAction(id: string) {
  return runAction((tx, actor) => policies.deletePenalty(tx, actor, uuid.parse(id)));
}

const assignInput = z.object({
  employeeIds: z.array(uuid).min(1).max(2000),
  kind: z.enum(["shift", "weekly_off", "capture", "penalty", "overtime"]),
  policyId: uuid.nullable(), from: isoDate,
});
export async function assignAction(input: z.input<typeof assignInput>) {
  const p = assignInput.safeParse(input);
  if (!p.success) return { ok: false as const, error: "Choose people, an option and an effective date." };
  return runAction((tx, actor) => policies.assign(tx, actor, p.data));
}

// ---------------------------------------------------------------- time2: overtime, pay codes, allowances, roster, shift rules, devices
import * as overtime from "@/server/modules/attendance/overtime";
import * as roster from "@/server/modules/attendance/roster";
import * as devices from "@/server/modules/attendance/devices";
import { withTenant } from "@/server/db";
import { requireActor } from "@/server/auth/session";

const dayRule = z.object({
  enabled: z.boolean(), mode: z.enum(["pay", "comp_off"]),
  coverage: z.object({ pre: z.boolean(), post: z.boolean() }),
  min_minutes: z.number().int(), max_minutes: z.number().int().nullable(),
  rounding: z.object({ to: z.union([z.literal(1), z.literal(15), z.literal(30), z.literal(60)]), mode: z.enum(["down", "nearest"]) }),
  pay_code_id: uuid.nullable(),
  tiers: z.array(z.object({ after_minutes: z.number().int(), multiplier: z.number() })).max(10),
});
const overtimeInput = z.object({
  name: z.string().max(80),
  rules: z.object({
    basis: z.enum(["effective", "gross"]), approval: z.enum(["none", "required"]), wage_basis: z.enum(["basic", "gross"]), hours_per_month: z.number().int(),
    comp_off: z.object({ full_day_minutes: z.number().int(), half_day_minutes: z.number().int() }),
    working: dayRule, weekly_off: dayRule, holiday: dayRule,
  }),
});
export async function saveOvertimePolicyAction(id: string | null, input: z.input<typeof overtimeInput>) {
  const p = overtimeInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => overtime.saveOvertimePolicy(tx, actor, idOrNull(id), p.data));
}
export async function deleteOvertimePolicyAction(id: string) {
  return runAction((tx, actor) => overtime.deleteOvertimePolicy(tx, actor, uuid.parse(id)));
}
const payCodeInput = z.object({ name: z.string().max(80), kind: z.enum(["multiplier", "fixed_per_hour", "lump_sum"]), value: z.number().nullable() });
export async function savePayCodeAction(id: string | null, input: z.input<typeof payCodeInput>) {
  const p = payCodeInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => overtime.savePayCode(tx, actor, idOrNull(id), p.data));
}
export async function deletePayCodeAction(id: string) {
  return runAction((tx, actor) => overtime.deletePayCode(tx, actor, uuid.parse(id)));
}
const allowanceInput = z.object({ name: z.string().max(80), shiftIds: z.array(uuid).max(50), amountPaise: z.number().int(), per: z.enum(["day", "shift"]), componentCode: z.string().max(31) });
export async function saveAllowancePolicyAction(id: string | null, input: z.input<typeof allowanceInput>) {
  const p = allowanceInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => overtime.saveAllowancePolicy(tx, actor, idOrNull(id), p.data));
}
export async function deleteAllowancePolicyAction(id: string) {
  return runAction((tx, actor) => overtime.deleteAllowancePolicy(tx, actor, uuid.parse(id)));
}
const month = z.string().regex(/^\d{4}-\d{2}$/);
/** Settle a month's overtime (payroll inputs / comp-off) and shift allowances for everyone. */
export async function settleMonthAction(m: string) {
  const p = month.safeParse(m);
  if (!p.success) return { ok: false as const, error: "Pick a month." };
  return runAction(async (tx, actor) => {
    const ot = await overtime.settleOvertime(tx, actor.tenant.id, p.data, actor);
    const sa = await overtime.settleShiftAllowance(tx, actor.tenant.id, p.data, actor);
    return { overtime: ot.lines, allowances: sa.lines };
  });
}

const rosterValue = z.union([uuid, z.literal("off"), z.null()]);
const rosterInput = z.array(z.object({ employeeId: uuid, date: isoDate, value: rosterValue })).min(1).max(5000);
export async function saveRosterAction(entries: z.input<typeof rosterInput>) {
  const p = rosterInput.safeParse(entries);
  if (!p.success) return bad;
  return runAction((tx, actor) => roster.saveRoster(tx, actor, p.data));
}
const rotationInput = z.object({
  employeeIds: z.array(uuid).min(1).max(500),
  rotation: z.discriminatedUnion("kind", [z.object({ kind: z.literal("weekly"), week: z.array(rosterValue).length(7) }), z.object({ kind: z.literal("cycle"), sequence: z.array(rosterValue).min(2).max(60) })]),
  start: isoDate, days: z.number().int(),
});
export async function applyRotationAction(input: z.input<typeof rotationInput>) {
  const p = rotationInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => roster.applyRotation(tx, actor, p.data));
}
/** Another week of the board, for client-side navigation without a full reload. */
export async function rosterWeekAction(date: string, q: string) {
  const d = isoDate.safeParse(date);
  if (!d.success) return null;
  const actor = await requireActor();
  return withTenant(actor.tenant.id, (tx) => roster.rosterWeek(tx, actor, d.data, q.slice(0, 80)));
}

const shiftRuleInput = z.object({ name: z.string().max(80), allowedShiftIds: z.array(uuid).max(50), requestWindowDays: z.number().int().nullable(), maxRequestsPerMonth: z.number().int().nullable(), allowOnOffDays: z.boolean() });
export async function saveShiftRuleAction(id: string | null, input: z.input<typeof shiftRuleInput>) {
  const p = shiftRuleInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => roster.saveShiftRule(tx, actor, idOrNull(id), p.data));
}
export async function deleteShiftRuleAction(id: string) {
  return runAction((tx, actor) => roster.deleteShiftRule(tx, actor, uuid.parse(id)));
}

const deviceInput = z.object({ name: z.string().max(80), serial: z.string().max(64), vendor: z.string().max(20), locationId: uuid.nullable() });
export async function createDeviceAction(input: z.input<typeof deviceInput>) {
  const p = deviceInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => devices.createDevice(tx, actor, p.data));
}
export async function updateDeviceAction(id: string, input: z.input<typeof deviceInput>) {
  const p = deviceInput.safeParse(input);
  if (!p.success) return bad;
  return runAction((tx, actor) => devices.updateDevice(tx, actor, uuid.parse(id), p.data));
}
export async function rotateDeviceKeyAction(id: string) {
  return runAction((tx, actor) => devices.rotateDeviceKey(tx, actor, uuid.parse(id)));
}
export async function deleteDeviceAction(id: string) {
  return runAction((tx, actor) => devices.deleteDevice(tx, actor, uuid.parse(id)));
}
