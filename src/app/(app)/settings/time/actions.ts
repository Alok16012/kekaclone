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
  kind: z.enum(["shift", "weekly_off", "capture", "penalty"]),
  policyId: uuid.nullable(), from: isoDate,
});
export async function assignAction(input: z.input<typeof assignInput>) {
  const p = assignInput.safeParse(input);
  if (!p.success) return { ok: false as const, error: "Choose people, an option and an effective date." };
  return runAction((tx, actor) => policies.assign(tx, actor, p.data));
}
