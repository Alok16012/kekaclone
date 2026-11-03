import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { hasAnyPerf, isAbove, oversees, perfAdminFor, personRow, reportIds } from "./access";

export type Visibility = "private" | "manager" | "public";
export const VISIBILITY_LABEL: Record<Visibility, string> = { private: "Only them", manager: "Them and their manager", public: "Anyone in the company" };

const bad = (p: z.ZodSafeParseError<unknown>) => new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));

async function activePerson(tx: Tx, id: string, field: string) {
  const p = await personRow(tx, id).catch(() => null);
  if (!p || p.status === "relieved") throw new AppError("invalid", "Pick someone who works here.", field);
  return p;
}

const giveInput = z.object({ toId: z.uuid("Pick who it's for"), body: z.string().trim().min(5, "Write a little more").max(4000), visibility: z.enum(["private", "manager", "public"]) });
/** Feedback to a colleague. Never to yourself. */
export async function giveFeedback(tx: Tx, actor: Actor, raw: unknown) {
  const p = giveInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const v = p.data;
  if (v.toId === actor.employeeId) throw new AppError("invalid", "You can't give feedback to yourself.", "toId");
  await activePerson(tx, v.toId, "toId");
  const [f] = await tx<{ id: string }[]>`
    insert into feedback_items (tenant_id, kind, from_employee_id, to_employee_id, about_employee_id, body, visibility, status)
    values (${actor.tenant.id}, 'feedback', ${actor.employeeId}, ${v.toId}, ${v.toId}, ${v.body}, ${v.visibility}, 'done') returning id`;
  await audit(tx, actor, { entityType: "feedback", entityId: f.id, action: "give", diff: { employeeId: v.toId, visibility: v.visibility } });
  await notifyEmployee(tx, actor.tenant.id, v.toId, "feedback.received", "You received feedback", `${actor.name} shared feedback with you.`, "/me/performance/feedback");
  return f;
}

const requestInput = z.object({
  askIds: z.array(z.uuid()).min(1, "Pick who to ask").max(10, "Ask up to 10 people at a time"),
  aboutId: z.uuid().nullable().optional(),
  question: z.string().trim().min(5, "Tell them what you'd like feedback on").max(1000),
});
/** Ask people for feedback about yourself, or (as their manager) about someone in your team. */
export async function requestFeedback(tx: Tx, actor: Actor, raw: unknown) {
  const p = requestInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const v = p.data;
  const about = v.aboutId ?? actor.employeeId;
  if (about !== actor.employeeId && !(await oversees(tx, actor, about))) throw new AppError("forbidden", "You can ask for feedback about yourself or people in your team.", "aboutId");
  const aboutP = await activePerson(tx, about, "aboutId");
  const ids: string[] = [];
  for (const askId of [...new Set(v.askIds)]) {
    if (askId === about) throw new AppError("invalid", "You can't ask someone for feedback about themselves.", "askIds");
    if (askId === actor.employeeId) throw new AppError("invalid", "You can't ask yourself.", "askIds");
    await activePerson(tx, askId, "askIds");
    const [open] = await tx`select 1 from feedback_items where kind = 'request' and status = 'pending' and from_employee_id = ${actor.employeeId} and to_employee_id = ${askId} and about_employee_id = ${about}`;
    if (open) continue;   // asking again while one is open does nothing
    const [f] = await tx<{ id: string }[]>`
      insert into feedback_items (tenant_id, kind, from_employee_id, to_employee_id, about_employee_id, body, visibility, status)
      values (${actor.tenant.id}, 'request', ${actor.employeeId}, ${askId}, ${about}, ${v.question}, 'private', 'pending') returning id`;
    ids.push(f.id);
    await notifyEmployee(tx, actor.tenant.id, askId, "feedback.requested", "Feedback requested",
      about === actor.employeeId ? `${actor.name} would like your feedback.` : `${actor.name} would like your feedback about ${aboutP.display_name}.`, "/me/performance/feedback?tab=requests");
  }
  await audit(tx, actor, { entityType: "feedback", entityId: ids[0] ?? null, action: "request", diff: { employeeId: about, asked: v.askIds.length, created: ids.length } });
  return { created: ids.length };
}

const respondInput = z.object({ body: z.string().trim().min(5, "Write a little more").max(4000), visibility: z.enum(["private", "manager", "public"]).default("manager") });
/** Answer a request: the feedback goes to the person it's about. Only the person asked can answer, once. */
export async function respondToRequest(tx: Tx, actor: Actor, requestId: string, raw: unknown) {
  const p = respondInput.safeParse(raw);
  if (!p.success) throw bad(p);
  const [r] = await tx<{ id: string; from_employee_id: string; about_employee_id: string }[]>`
    update feedback_items set status = 'done', responded_at = now() where id = ${requestId} and kind = 'request' and to_employee_id = ${actor.employeeId} and status = 'pending'
    returning id, from_employee_id, about_employee_id`;
  if (!r) throw new AppError("conflict", "This request was already answered or isn't yours.");
  // when a manager asked about a report, the manager must be able to read the answer
  const visibility: Visibility = r.from_employee_id !== r.about_employee_id && p.data.visibility === "private" ? "manager" : p.data.visibility;
  const [f] = await tx<{ id: string }[]>`
    insert into feedback_items (tenant_id, kind, from_employee_id, to_employee_id, about_employee_id, body, visibility, status, request_id)
    values (${actor.tenant.id}, 'feedback', ${actor.employeeId}, ${r.about_employee_id}, ${r.about_employee_id}, ${p.data.body}, ${visibility}, 'done', ${r.id}) returning id`;
  await audit(tx, actor, { entityType: "feedback", entityId: f.id, action: "respond", diff: { employeeId: r.about_employee_id, requestId } });
  await notifyEmployee(tx, actor.tenant.id, r.from_employee_id, "feedback.answered", "Your feedback request was answered", `${actor.name} replied.`, "/me/performance/feedback?tab=given");
  return f;
}

export async function declineRequest(tx: Tx, actor: Actor, requestId: string) {
  const [r] = await tx<{ from_employee_id: string }[]>`
    update feedback_items set status = 'declined', responded_at = now() where id = ${requestId} and kind = 'request' and to_employee_id = ${actor.employeeId} and status = 'pending' returning from_employee_id`;
  if (!r) throw new AppError("conflict", "This request was already answered or isn't yours.");
  await audit(tx, actor, { entityType: "feedback", entityId: requestId, action: "decline" });
  await notifyEmployee(tx, actor.tenant.id, r.from_employee_id, "feedback.declined", "A feedback request was declined", `${actor.name} can't give feedback this time.`, "/me/performance/feedback?tab=requests");
}

const noteInput = z.object({ aboutId: z.uuid("Pick who the note is about"), body: z.string().trim().min(2, "Write the note").max(4000) });
/** A private note about someone in your team. Never visible to that person; their managers and covering admins can read it. */
export async function addNote(tx: Tx, actor: Actor, raw: unknown) {
  const p = noteInput.safeParse(raw);
  if (!p.success) throw bad(p);
  if (!(await oversees(tx, actor, p.data.aboutId))) throw new AppError("forbidden", "You can keep notes about people in your team.", "aboutId");
  const [f] = await tx<{ id: string }[]>`
    insert into feedback_items (tenant_id, kind, from_employee_id, to_employee_id, about_employee_id, body, visibility, status)
    values (${actor.tenant.id}, 'internal_note', ${actor.employeeId}, ${p.data.aboutId}, ${p.data.aboutId}, ${p.data.body}, 'manager', 'done') returning id`;
  await audit(tx, actor, { entityType: "feedback", entityId: f.id, action: "note", diff: { employeeId: p.data.aboutId } });
  return f;
}

export async function deleteOwn(tx: Tx, actor: Actor, id: string) {
  const [r] = await tx<{ id: string }[]>`delete from feedback_items where id = ${id} and from_employee_id = ${actor.employeeId} and kind in ('feedback','internal_note') returning id`;
  if (!r) throw new AppError("not_found", "Feedback not found.");
  await audit(tx, actor, { entityType: "feedback", entityId: id, action: "delete" });
}

export type FeedbackRow = {
  id: string; kind: "feedback" | "request" | "internal_note"; from_id: string; from_name: string; to_id: string; to_name: string; about_id: string | null; about_name: string | null;
  body: string | null; visibility: Visibility; status: "pending" | "done" | "declined"; created_at: string; request_question: string | null;
};
const cols = (tx: Tx) => tx`
  f.id, f.kind, f.from_employee_id as from_id, fe.display_name as from_name, f.to_employee_id as to_id, te.display_name as to_name,
  f.about_employee_id as about_id, ae.display_name as about_name, f.body, f.visibility, f.status, f.created_at, rq.body as request_question`;
const from = (tx: Tx) => tx`
  feedback_items f join employees fe on fe.id = f.from_employee_id join employees te on te.id = f.to_employee_id
  left join employees ae on ae.id = f.about_employee_id left join feedback_items rq on rq.id = f.request_id`;
const out = (rows: (Omit<FeedbackRow, "created_at"> & { created_at: Date })[]) => rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));

/** The actor's feedback tabs. */
export async function myFeedback(tx: Tx, actor: Actor) {
  const me = actor.employeeId;
  const [received, given, requests, notes] = await Promise.all([
    tx`select ${cols(tx)} from ${from(tx)} where f.kind = 'feedback' and f.to_employee_id = ${me} order by f.created_at desc limit 200`,
    tx`select ${cols(tx)} from ${from(tx)} where f.kind in ('feedback','request') and f.from_employee_id = ${me} order by f.created_at desc limit 200`,
    tx`select ${cols(tx)} from ${from(tx)} where f.kind = 'request' and f.to_employee_id = ${me} order by (f.status = 'pending') desc, f.created_at desc limit 200`,
    tx`select ${cols(tx)} from ${from(tx)} where f.kind = 'internal_note' and f.from_employee_id = ${me} order by f.created_at desc limit 200`,
  ]);
  const praise = await tx<{ id: string; from_name: string; body: string | null; badge: string | null; created_at: Date }[]>`
    select p.id, e.display_name as from_name, p.body, b.name as badge, p.created_at from praise_recipients r join posts p on p.id = r.post_id
    join employees e on e.id = p.author_employee_id left join badges b on b.id = p.badge_id
    where r.employee_id = ${me} and p.kind = 'praise' order by p.created_at desc limit 50`;
  return {
    received: out(received as never), given: out(given as never), requests: out(requests as never), notes: out(notes as never),
    praise: praise.map((p) => ({ ...p, created_at: p.created_at.toISOString() })),
  };
}

/** What a manager / admin sees about one person: feedback shared beyond private, plus internal notes. Never for yourself (use myFeedback). */
export async function feedbackAbout(tx: Tx, actor: Actor, employeeId: string) {
  if (!(await oversees(tx, actor, employeeId))) throw new AppError("forbidden", "You can see feedback about people in your team.");
  const rows = await tx`
    select ${cols(tx)} from ${from(tx)}
    where f.about_employee_id = ${employeeId} and ((f.kind = 'feedback' and f.visibility in ('manager','public')) or f.kind = 'internal_note')
    order by f.created_at desc limit 200`;
  return out(rows as never);
}

/** May the actor read this one item? (Used by tests and detail views.) */
export async function canRead(tx: Tx, actor: Actor, id: string) {
  const [f] = await tx<{ kind: string; from_employee_id: string; to_employee_id: string; about_employee_id: string | null; visibility: Visibility }[]>`
    select kind, from_employee_id, to_employee_id, about_employee_id, visibility from feedback_items where id = ${id}`;
  if (!f) return false;
  const me = actor.employeeId;
  if (f.from_employee_id === me) return true;
  if (f.kind === "internal_note") return f.about_employee_id !== me && (await oversees(tx, actor, f.about_employee_id!));
  if (f.to_employee_id === me) return true;
  if (f.visibility === "public") return true;
  if (f.visibility === "manager" && f.about_employee_id) return (await isAbove(tx, me, f.about_employee_id)) || perfAdminFor(actor, await personRow(tx, f.about_employee_id));
  return false;
}

/** Admin summary: given / received / requested / praise per person over a date range, for the people the admin covers. */
export async function feedbackSummary(tx: Tx, actor: Actor, fromDate: string, toDate: string) {
  if (!hasAnyPerf(actor)) throw new AppError("forbidden", "You don't have access to performance reports.");
  const rows = await tx<{ id: string; name: string; department: string | null; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null; given: number; received: number; requested: number; praise: number }[]>`
    select e.id, e.display_name as name, d.name as department, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      (select count(*)::int from feedback_items f where f.kind = 'feedback' and f.from_employee_id = e.id and f.created_at::date between ${fromDate} and ${toDate}) as given,
      (select count(*)::int from feedback_items f where f.kind = 'feedback' and f.to_employee_id = e.id and f.created_at::date between ${fromDate} and ${toDate}) as received,
      (select count(*)::int from feedback_items f where f.kind = 'request' and f.from_employee_id = e.id and f.created_at::date between ${fromDate} and ${toDate}) as requested,
      (select count(*)::int from praise_recipients r join posts p on p.id = r.post_id where r.employee_id = e.id and p.kind = 'praise' and p.created_at::date between ${fromDate} and ${toDate}) as praise
    from employees e left join departments d on d.id = e.department_id where e.status <> 'relieved' order by e.display_name`;
  const mine = rows.filter((r) => perfAdminFor(actor, r)).map((r) => ({ id: r.id, name: r.name, department: r.department, given: r.given, received: r.received, requested: r.requested, praise: r.praise }));
  const total = mine.reduce((s, r) => ({ given: s.given + r.given, received: s.received + r.received, requested: s.requested + r.requested, praise: s.praise + r.praise }), { given: 0, received: 0, requested: 0, praise: 0 });
  return { people: mine, total, silent: mine.filter((r) => r.received === 0 && r.praise === 0).length };
}

/** People the actor can keep notes about / request feedback about (their reports). */
export async function teamFor(tx: Tx, actor: Actor) {
  const ids = await reportIds(tx, actor.employeeId);
  if (!ids.length) return [];
  return tx<{ id: string; name: string }[]>`select id, display_name as name from employees where id = any(${ids}::uuid[]) order by display_name`;
}
