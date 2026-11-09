import "server-only";
import { cancelCalendarEvent, pushCalendarEvent } from "@/server/modules/calendar/service";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { personRow } from "./access";
import { nextOccurrence, type Recurrence } from "./rules";

type Meeting = { id: string; series_id: string | null; organizer_employee_id: string; attendee_employee_id: string; starts_at: Date; ends_at: Date; recurrence: Recurrence | null; purpose: string | null; shared_notes: string | null; status: "scheduled" | "completed" | "cancelled" };

async function meeting(tx: Tx, actor: Actor, id: string, lock = false) {
  const [m] = lock
    ? await tx<Meeting[]>`select id, series_id, organizer_employee_id, attendee_employee_id, starts_at, ends_at, recurrence, purpose, shared_notes, status from one_on_ones where id = ${id} for update`
    : await tx<Meeting[]>`select id, series_id, organizer_employee_id, attendee_employee_id, starts_at, ends_at, recurrence, purpose, shared_notes, status from one_on_ones where id = ${id}`;
  // only the two people in the meeting can see it
  if (!m || (m.organizer_employee_id !== actor.employeeId && m.attendee_employee_id !== actor.employeeId)) throw new AppError("not_found", "Meeting not found.");
  return m;
}
const other = (m: Meeting, actor: Actor) => (m.organizer_employee_id === actor.employeeId ? m.attendee_employee_id : m.organizer_employee_id);
const when = (d: Date) => d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

export const scheduleInput = z.object({
  attendeeId: z.uuid("Pick who you're meeting"),
  startsAt: z.iso.datetime({ offset: true, message: "Pick a date and time" }),
  durationMins: z.number().int().min(10, "At least 10 minutes").max(240, "At most 4 hours"),
  recurrence: z.enum(["weekly", "biweekly", "monthly"]).nullable(),
  purpose: z.string().trim().max(200).nullable().optional(),
  agenda: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
});

export async function scheduleOneOnOne(tx: Tx, actor: Actor, raw: unknown) {
  const p = scheduleInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  if (v.attendeeId === actor.employeeId) throw new AppError("invalid", "Pick someone other than yourself.", "attendeeId");
  const a = await personRow(tx, v.attendeeId).catch(() => null);
  if (!a || a.status === "relieved") throw new AppError("invalid", "Pick someone who works here.", "attendeeId");
  const starts = new Date(v.startsAt), ends = new Date(starts.getTime() + v.durationMins * 60_000);
  const [m] = await tx<{ id: string }[]>`
    insert into one_on_ones (tenant_id, series_id, organizer_employee_id, attendee_employee_id, starts_at, ends_at, recurrence, purpose)
    values (${actor.tenant.id}, ${v.recurrence ? randomUUID() : null}, ${actor.employeeId}, ${v.attendeeId}, ${starts}, ${ends}, ${v.recurrence}, ${v.purpose || null}) returning id`;
  for (const body of v.agenda) await tx`insert into one_on_one_items (tenant_id, meeting_id, kind, author_employee_id, body) values (${actor.tenant.id}, ${m.id}, 'agenda', ${actor.employeeId}, ${body})`;
  await audit(tx, actor, { entityType: "one_on_one", entityId: m.id, action: "schedule", diff: { employeeId: v.attendeeId, startsAt: v.startsAt, recurrence: v.recurrence } });
  await pushCalendarEvent(tx, actor.tenant.id, "one_on_one", m.id, [actor.employeeId, v.attendeeId], { title: `1:1: ${actor.name} & ${a.display_name}`, start: starts.toISOString(), end: ends.toISOString(), description: v.purpose || "1:1 scheduled in erp" });
  await notifyEmployee(tx, actor.tenant.id, v.attendeeId, "one_on_one.scheduled", "1:1 scheduled", `${actor.name} set up a 1:1 on ${when(starts)}${v.recurrence ? ` (repeats ${v.recurrence === "biweekly" ? "every two weeks" : v.recurrence})` : ""}.`, `/me/performance/one-on-ones?open=${m.id}`);
  return m;
}

export async function reschedule(tx: Tx, actor: Actor, id: string, startsAt: string, durationMins: number) {
  const m = await meeting(tx, actor, id, true);
  if (m.organizer_employee_id !== actor.employeeId) throw new AppError("forbidden", "Only the organiser can move this meeting.");
  if (m.status !== "scheduled") throw new AppError("invalid", "This meeting is already over.");
  const s = new Date(startsAt);
  if (Number.isNaN(s.getTime())) throw new AppError("invalid", "Pick a date and time.", "startsAt");
  if (durationMins < 10 || durationMins > 240) throw new AppError("invalid", "Between 10 minutes and 4 hours.", "durationMins");
  await tx`update one_on_ones set starts_at = ${s}, ends_at = ${new Date(s.getTime() + durationMins * 60_000)} where id = ${id}`;
  await audit(tx, actor, { entityType: "one_on_one", entityId: id, action: "reschedule", diff: { startsAt } });
  await notifyEmployee(tx, actor.tenant.id, other(m, actor), "one_on_one.moved", "1:1 moved", `${actor.name} moved your 1:1 to ${when(s)}.`, `/me/performance/one-on-ones?open=${id}`);
}

/** Creates the next meeting in a series (once) and moves open action items onto it. */
async function rollForward(tx: Tx, actor: Actor, m: Meeting) {
  if (!m.recurrence || !m.series_id) return null;
  const [later] = await tx<{ id: string }[]>`select id from one_on_ones where series_id = ${m.series_id} and starts_at > ${m.starts_at} and status = 'scheduled' order by starts_at limit 1`;
  let nextId = later?.id;
  if (!nextId) {
    const s = nextOccurrence(m.starts_at, m.recurrence), e = new Date(s.getTime() + (m.ends_at.getTime() - m.starts_at.getTime()));
    const [n] = await tx<{ id: string }[]>`
      insert into one_on_ones (tenant_id, series_id, organizer_employee_id, attendee_employee_id, starts_at, ends_at, recurrence, purpose)
      values (${actor.tenant.id}, ${m.series_id}, ${m.organizer_employee_id}, ${m.attendee_employee_id}, ${s}, ${e}, ${m.recurrence}, ${m.purpose}) returning id`;
    nextId = n.id;
  }
  await tx`update one_on_one_items set meeting_id = ${nextId}, carried_from_meeting_id = coalesce(carried_from_meeting_id, ${m.id})
           where meeting_id = ${m.id} and kind = 'action_item' and done_at is null`;
  return nextId;
}

/** Mark as done. A recurring 1:1 gets its next meeting, and unfinished action items move to it. Safe to repeat. */
export async function completeMeeting(tx: Tx, actor: Actor, id: string) {
  const m = await meeting(tx, actor, id, true);
  if (m.status === "completed") return { nextId: null };
  if (m.status === "cancelled") throw new AppError("invalid", "This meeting was cancelled.");
  await tx`update one_on_ones set status = 'completed' where id = ${id}`;
  const nextId = await rollForward(tx, actor, m);
  await audit(tx, actor, { entityType: "one_on_one", entityId: id, action: "complete", diff: { nextId } });
  return { nextId };
}

/** Cancel one meeting (a recurring series carries on unless `endSeries`). */
export async function cancelMeeting(tx: Tx, actor: Actor, id: string, endSeries = false) {
  const m = await meeting(tx, actor, id, true);
  if (m.status !== "scheduled") throw new AppError("invalid", "Only upcoming meetings can be cancelled.");
  await cancelCalendarEvent(tx, "one_on_one", id);
  await tx`update one_on_ones set status = 'cancelled' where id = ${id}`;
  let nextId: string | null = null;
  if (endSeries && m.series_id) await tx`update one_on_ones set status = 'cancelled' where series_id = ${m.series_id} and status = 'scheduled'`;
  else nextId = await rollForward(tx, actor, m);
  await audit(tx, actor, { entityType: "one_on_one", entityId: id, action: "cancel", diff: { endSeries } });
  await notifyEmployee(tx, actor.tenant.id, other(m, actor), "one_on_one.cancelled", "1:1 cancelled", `${actor.name} cancelled the 1:1 on ${when(m.starts_at)}${endSeries ? " and the ones after it" : ""}.`, "/me/performance/one-on-ones");
  return { nextId };
}

export async function saveSharedNotes(tx: Tx, actor: Actor, id: string, notes: string) {
  const m = await meeting(tx, actor, id, true);
  if (m.status === "cancelled") throw new AppError("invalid", "This meeting was cancelled.");
  await tx`update one_on_ones set shared_notes = ${notes.trim().slice(0, 10_000) || null} where id = ${id}`;
  await audit(tx, actor, { entityType: "one_on_one", entityId: id, action: "notes" });
}

const itemInput = z.object({
  kind: z.enum(["agenda", "private_note", "action_item"]),
  body: z.string().trim().min(1, "Write something").max(2000),
  assigneeId: z.uuid().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
});
/** Talking points and action items are shared; private notes are seen only by their author. */
export async function addItem(tx: Tx, actor: Actor, meetingId: string, raw: unknown) {
  const p = itemInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const m = await meeting(tx, actor, meetingId);
  if (m.status === "cancelled") throw new AppError("invalid", "This meeting was cancelled.");
  const v = p.data;
  const assignee = v.kind === "action_item" ? v.assigneeId ?? actor.employeeId : null;
  if (assignee && assignee !== m.organizer_employee_id && assignee !== m.attendee_employee_id) throw new AppError("invalid", "Action items go to one of the two of you.", "assigneeId");
  const [i] = await tx<{ id: string }[]>`
    insert into one_on_one_items (tenant_id, meeting_id, kind, author_employee_id, body, assignee_employee_id, due_date)
    values (${actor.tenant.id}, ${meetingId}, ${v.kind}, ${actor.employeeId}, ${v.body}, ${assignee}, ${v.kind === "action_item" ? v.dueDate ?? null : null}) returning id`;
  if (v.kind !== "private_note") await audit(tx, actor, { entityType: "one_on_one", entityId: meetingId, action: `item.${v.kind}` });
  return i;
}

export async function setActionDone(tx: Tx, actor: Actor, itemId: string, done: boolean) {
  const [i] = await tx<{ meeting_id: string; kind: string }[]>`select meeting_id, kind from one_on_one_items where id = ${itemId}`;
  if (!i || i.kind !== "action_item") throw new AppError("not_found", "Action item not found.");
  await meeting(tx, actor, i.meeting_id);
  await tx`update one_on_one_items set done_at = ${done ? tx`now()` : null} where id = ${itemId}`;
}

export async function deleteItem(tx: Tx, actor: Actor, itemId: string) {
  const [i] = await tx<{ id: string }[]>`delete from one_on_one_items where id = ${itemId} and author_employee_id = ${actor.employeeId} returning id`;
  if (!i) throw new AppError("not_found", "Only the person who added it can remove it.");
}

export type MeetingRow = { id: string; with_id: string; with_name: string; organizer: boolean; starts_at: string; ends_at: string; recurrence: Recurrence | null; purpose: string | null; status: Meeting["status"]; open_actions: number; agenda: number };

export async function listMeetings(tx: Tx, actor: Actor) {
  const rows = await tx<(Omit<MeetingRow, "starts_at" | "ends_at"> & { starts_at: Date; ends_at: Date })[]>`
    select m.id, case when m.organizer_employee_id = ${actor.employeeId} then m.attendee_employee_id else m.organizer_employee_id end as with_id,
      e.display_name as with_name, m.organizer_employee_id = ${actor.employeeId} as organizer, m.starts_at, m.ends_at, m.recurrence, m.purpose, m.status,
      (select count(*)::int from one_on_one_items i where i.meeting_id = m.id and i.kind = 'action_item' and i.done_at is null) as open_actions,
      (select count(*)::int from one_on_one_items i where i.meeting_id = m.id and i.kind = 'agenda') as agenda
    from one_on_ones m join employees e on e.id = case when m.organizer_employee_id = ${actor.employeeId} then m.attendee_employee_id else m.organizer_employee_id end
    where ${actor.employeeId} in (m.organizer_employee_id, m.attendee_employee_id)
    order by m.starts_at desc limit 300`;
  return rows.map((r) => ({ ...r, starts_at: r.starts_at.toISOString(), ends_at: r.ends_at.toISOString() }));
}

export async function meetingDetail(tx: Tx, actor: Actor, id: string) {
  const m = await meeting(tx, actor, id).catch(() => null);
  if (!m) return null;
  const items = await tx<{ id: string; kind: "agenda" | "private_note" | "action_item"; body: string; author_id: string; author: string; assignee_id: string | null; assignee: string | null; due_date: string | null; done: boolean; carried: boolean; created_at: Date }[]>`
    select i.id, i.kind, i.body, i.author_employee_id as author_id, a.display_name as author, i.assignee_employee_id as assignee_id, s.display_name as assignee,
      i.due_date::text, i.done_at is not null as done, i.carried_from_meeting_id is not null as carried, i.created_at
    from one_on_one_items i join employees a on a.id = i.author_employee_id left join employees s on s.id = i.assignee_employee_id
    where i.meeting_id = ${id} and (i.kind <> 'private_note' or i.author_employee_id = ${actor.employeeId})
    order by i.created_at`;
  const people = await tx<{ id: string; name: string }[]>`select id, display_name as name from employees where id in (${m.organizer_employee_id}, ${m.attendee_employee_id})`;
  const history = m.series_id ? await tx<{ id: string; starts_at: Date; status: string }[]>`select id, starts_at, status from one_on_ones where series_id = ${m.series_id} order by starts_at desc limit 20` : [];
  return {
    id: m.id, organizerId: m.organizer_employee_id, attendeeId: m.attendee_employee_id, people, isOrganizer: m.organizer_employee_id === actor.employeeId,
    startsAt: m.starts_at.toISOString(), endsAt: m.ends_at.toISOString(), recurrence: m.recurrence, purpose: m.purpose, sharedNotes: m.shared_notes ?? "", status: m.status,
    items: items.map((i) => ({ ...i, created_at: i.created_at.toISOString() })),
    history: history.map((h) => ({ id: h.id, starts_at: h.starts_at.toISOString(), status: h.status })),
  };
}
