"use server";
import { headers } from "next/headers";
import { z } from "zod";
import { runAction } from "@/server/action";
import { withTenant } from "@/server/db";
import { requireActor } from "@/server/auth/session";
import * as attendance from "@/server/modules/attendance/service";
import * as requests from "@/server/modules/attendance/requests";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const uuid = z.uuid();

const clockInput = z.object({
  expect: z.enum(["in", "out"]),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  accuracy: z.number().min(0).nullable().optional(),
  fixAgeMs: z.number().min(0).max(1e9).nullable().optional(),
  comment: z.string().max(500).optional(),
  selfie: z.string().max(2_200_000).nullable().optional(),
  deviceKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).nullable().optional(),
  deviceLabel: z.string().max(80).nullable().optional(),
});

/** Clock in / out. Location is optional and only sent when the policy needs it; the server decides. */
export async function punchAction(input: z.input<typeof clockInput>) {
  const parsed = clockInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Something about this clock-in looks off. Please try again." };
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return runAction((tx, actor) => attendance.punch(tx, actor, { ip, ...parsed.data }));
}

const requestInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("regularization"), date: isoDate, inTime: hhmm, outTime: hhmm, reason: z.string().max(1000) }),
  z.object({ kind: z.enum(["wfh", "on_duty"]), from: isoDate, to: isoDate, half: z.enum(["first", "second"]).nullable(), reason: z.string().max(1000) }),
  z.object({ kind: z.literal("partial_day"), date: isoDate, type: z.enum(["late_arrival", "early_leave"]), minutes: z.number().int(), reason: z.string().max(1000) }),
  z.object({ kind: z.literal("overtime"), date: isoDate, minutes: z.number().int(), reason: z.string().max(1000) }),
  z.object({ kind: z.literal("shift_change"), from: isoDate, to: isoDate, shiftId: uuid, reason: z.string().max(1000) }),
  z.object({ kind: z.literal("weekly_off_change"), offDate: isoDate, workDate: isoDate, reason: z.string().max(1000) }),
]);

export async function createAttendanceRequestAction(input: z.input<typeof requestInput>) {
  const parsed = requestInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Check the dates and times." };
  return runAction((tx, actor) => requests.createRequest(tx, actor, parsed.data));
}

export async function cancelAttendanceRequestAction(id: string) {
  const parsed = uuid.safeParse(id);
  if (!parsed.success) return { ok: false as const, error: "Unknown request." };
  return runAction((tx, actor) => requests.cancelRequest(tx, actor, parsed.data));
}

/** Inbox drawer detail. Only the requester, their approvers and attendance admins can read it. */
export async function attendanceRequestDetailAction(id: string) {
  const parsed = uuid.safeParse(id);
  if (!parsed.success) return null;
  const actor = await requireActor();
  return withTenant(actor.tenant.id, (tx) => requests.requestDetail(tx, actor, parsed.data));
}
