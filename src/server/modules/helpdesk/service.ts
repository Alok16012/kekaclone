import "server-only";
import { emitEvent } from "@/server/modules/automations/service";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { validateUpload } from "@/server/modules/documents/rules";
import { saveFile } from "@/server/storage";
import {
  allowedActions, dueAt, escalationsDue, MAX_ATTACHMENTS, nextStatus, pickAssignee, slaState, ticketRef, validateCategory, DEFAULT_TICKET_CATEGORIES,
  type CategoryInput, type Priority, type TicketAction, type TicketStatus,
} from "./rules";

export const HELPDESK_ADMIN = "helpdesk.admin";
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/** Categories and every ticket are company-wide, so helpdesk admin needs the permission with no department / location scope. */
export const canAdminHelpdesk = (actor: Actor) => canFor(actor, HELPDESK_ADMIN, EVERYWHERE);

export type UploadedFile = { name: string; bytes: Uint8Array };

// ---------- defaults ----------
/** Starter categories for a new company. Safe to run again: existing names are left alone. */
export async function ensureHelpdeskDefaults(tx: Tx, tenantId: string) {
  for (const c of DEFAULT_TICKET_CATEGORIES) {
    await tx`insert into ticket_categories (tenant_id, name, priority, first_response_sla_mins, resolution_sla_mins)
             values (${tenantId}, ${c.name}, ${c.priority}, ${c.first}, ${c.resolution}) on conflict (tenant_id, name) do nothing`;
  }
}

// ---------- categories (Settings → Helpdesk) ----------
export type CategoryRow = {
  id: string; name: string; priority: Priority; first_response_sla_mins: number | null; resolution_sla_mins: number | null;
  assignee_employee_ids: string[]; escalate_to_employee_id: string | null; escalate_to: string | null; agents: string[]; open_tickets: number; total_tickets: number;
};

export async function listCategories(tx: Tx): Promise<CategoryRow[]> {
  return tx<CategoryRow[]>`
    select c.id, c.name, c.priority, c.first_response_sla_mins, c.resolution_sla_mins, c.assignee_employee_ids, c.escalate_to_employee_id,
      x.display_name as escalate_to,
      coalesce((select array_agg(e.display_name order by e.display_name) from employees e where e.id = any(c.assignee_employee_ids)), '{}') as agents,
      (select count(*)::int from tickets t where t.category_id = c.id and t.status <> 'closed') as open_tickets,
      (select count(*)::int from tickets t where t.category_id = c.id) as total_tickets
    from ticket_categories c left join employees x on x.id = c.escalate_to_employee_id
    order by c.name`;
}

function assertAdmin(actor: Actor) {
  if (!canAdminHelpdesk(actor)) throw new AppError("forbidden", "You don't have access to do this.");
}

export async function saveCategory(tx: Tx, actor: Actor, id: string | null, input: CategoryInput) {
  assertAdmin(actor);
  const problems = validateCategory(input);
  if (problems.length) throw new AppError("invalid", problems[0].message, problems[0].field);
  const people = [...input.assigneeIds, ...(input.escalateToId ? [input.escalateToId] : [])];
  if (people.length) {
    const [{ n }] = await tx<{ n: number }[]>`select count(distinct id)::int as n from employees where id = any(${people}::uuid[]) and status <> 'relieved'`;
    if (n !== new Set(people).size) throw new AppError("invalid", "Some of the people you picked have left or don't exist.", "assigneeIds");
  }
  const name = input.name.trim();
  const [dup] = await tx<{ id: string }[]>`select id from ticket_categories where lower(name) = lower(${name}) and id is distinct from ${id}`;
  if (dup) throw new AppError("conflict", "A category with this name already exists.", "name");
  const vals = { name, priority: input.priority, first: input.firstResponseMins, res: input.resolutionMins, agents: input.assigneeIds, esc: input.escalateToId };
  if (id) {
    const [r] = await tx<{ id: string }[]>`
      update ticket_categories set name = ${vals.name}, priority = ${vals.priority}, first_response_sla_mins = ${vals.first}, resolution_sla_mins = ${vals.res},
        assignee_employee_ids = ${vals.agents}::uuid[], escalate_to_employee_id = ${vals.esc} where id = ${id} returning id`;
    if (!r) throw new AppError("not_found", "Category not found.");
    return r;
  }
  const [r] = await tx<{ id: string }[]>`
    insert into ticket_categories (tenant_id, name, priority, first_response_sla_mins, resolution_sla_mins, assignee_employee_ids, escalate_to_employee_id)
    values (${actor.tenant.id}, ${vals.name}, ${vals.priority}, ${vals.first}, ${vals.res}, ${vals.agents}::uuid[], ${vals.esc}) returning id`;
  return r;
}

export async function deleteCategory(tx: Tx, actor: Actor, id: string) {
  assertAdmin(actor);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tickets where category_id = ${id}`;
  if (n) throw new AppError("invalid", "This category has tickets, so it can't be deleted. Rename it instead.");
  const r = await tx`delete from ticket_categories where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Category not found.");
}

// ---------- access ----------
type TicketCore = {
  id: string; number: bigint | number; category_id: string; category: string; raised_by_employee_id: string; assignee_employee_id: string | null;
  title: string; priority: Priority; status: TicketStatus; created_at: Date; updated_at: Date;
  first_response_due_at: Date | null; first_responded_at: Date | null; resolution_due_at: Date | null; closed_at: Date | null;
  first_response_escalated_at: Date | null; resolution_escalated_at: Date | null; reopened_count: number;
  agents: string[]; escalate_to: string | null; resolution_sla_mins: number | null;
};

async function ticketCore(tx: Tx, id: string, lock = false) {
  const [t] = await tx<TicketCore[]>`
    select t.id, t.number, t.category_id, c.name as category, t.raised_by_employee_id, t.assignee_employee_id, t.title, t.priority, t.status, t.created_at, t.updated_at,
      t.first_response_due_at, t.first_responded_at, t.resolution_due_at, t.closed_at, t.first_response_escalated_at, t.resolution_escalated_at, t.reopened_count,
      c.assignee_employee_ids as agents, c.escalate_to_employee_id as escalate_to, c.resolution_sla_mins
    from tickets t join ticket_categories c on c.id = t.category_id where t.id = ${id} ${lock ? tx`for update of t` : tx``}`;
  return t ?? null;
}

/**
 * Who the actor is on a ticket. The requester only ever acts as the requester (no internal notes, no assigning their own
 * ticket); agents are the category's agents and its escalation contact; helpdesk admins act as agents on everything.
 */
function roleOn(actor: Actor, t: Pick<TicketCore, "raised_by_employee_id" | "agents" | "escalate_to">) {
  const requester = t.raised_by_employee_id === actor.employeeId;
  const agent = !requester && (canAdminHelpdesk(actor) || t.agents.includes(actor.employeeId) || t.escalate_to === actor.employeeId);
  return { requester, agent, visible: requester || agent };
}

/** Is the actor an agent anywhere (for showing the queue)? */
export async function isAgent(tx: Tx, actor: Actor) {
  if (canAdminHelpdesk(actor)) return true;
  const [r] = await tx<{ ok: boolean }[]>`select exists(select 1 from ticket_categories where ${actor.employeeId}::uuid = any(assignee_employee_ids) or escalate_to_employee_id = ${actor.employeeId}) as ok`;
  return r.ok;
}

async function helpdeskAdmins(tx: Tx, exceptId: string) {
  const rows = await tx<{ id: string }[]>`
    select distinct ra.employee_id as id from role_assignments ra join roles r on r.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved'
    where (${HELPDESK_ADMIN} = any(r.permissions) or '*' = any(r.permissions)) and jsonb_array_length(ra.scopes) = 0 and ra.employee_id <> ${exceptId}`;
  return rows.map((r) => r.id);
}

async function saveAttachments(tx: Tx, actor: Actor, files: UploadedFile[]) {
  if (files.length > MAX_ATTACHMENTS) throw new AppError("invalid", `Attach at most ${MAX_ATTACHMENTS} files.`, "files");
  const ids: string[] = [];
  for (const f of files) {
    const v = validateUpload({ name: f.name, size: f.bytes.byteLength, head: f.bytes.subarray(0, 512) });
    if (!v.ok) throw new AppError("invalid", `${f.name}: ${v.error}`, "files");
    ids.push(await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: v.name, mime: v.mime, bytes: f.bytes, ext: v.name.split(".").pop() ?? "" }));
  }
  return ids;
}

async function audit(tx: Tx, actor: Actor | null, ticketId: string, action: string, diff: Record<string, unknown> = {}) {
  if (!actor) return;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'ticket', ${ticketId}, ${action}, ${tx.json(diff as never)})`;
}

// ---------- raise ----------
export type RaiseInput = { categoryId: string; title: string; description: string; files: UploadedFile[] };

export async function raiseTicket(tx: Tx, actor: Actor, input: RaiseInput, now = new Date()) {
  const title = input.title.trim().slice(0, 160);
  const description = input.description.trim().slice(0, 5000);
  if (!title) throw new AppError("invalid", "Add a short subject.", "title");
  if (!description) throw new AppError("invalid", "Describe what you need help with.", "description");
  const [c] = await tx<{ id: string; name: string; priority: Priority; first_response_sla_mins: number | null; resolution_sla_mins: number | null; assignee_employee_ids: string[] }[]>`
    select id, name, priority, first_response_sla_mins, resolution_sla_mins, assignee_employee_ids from ticket_categories where id = ${input.categoryId}`;
  if (!c) throw new AppError("not_found", "Pick a category.", "categoryId");
  const fileIds = await saveAttachments(tx, actor, input.files);

  // only agents who are still here take new tickets; the least busy one gets it
  const active = await tx<{ id: string; open: number }[]>`
    select e.id, (select count(*)::int from tickets t where t.assignee_employee_id = e.id and t.status <> 'closed') as open
    from employees e where e.id = any(${c.assignee_employee_ids}::uuid[]) and e.status <> 'relieved'`;
  const counts = Object.fromEntries(active.map((a) => [a.id, a.open]));
  const assignee = pickAssignee(c.assignee_employee_ids.filter((id) => id in counts), counts, actor.employeeId);

  const [{ value: number }] = await tx<{ value: bigint }[]>`
    insert into counters (tenant_id, key, value) values (${actor.tenant.id}, 'ticket', 1)
    on conflict (tenant_id, key) do update set value = counters.value + 1 returning value`;
  const [t] = await tx<{ id: string }[]>`
    insert into tickets (tenant_id, number, category_id, raised_by_employee_id, assignee_employee_id, title, description, priority, status, first_response_due_at, resolution_due_at, created_at)
    values (${actor.tenant.id}, ${number.toString()}, ${c.id}, ${actor.employeeId}, ${assignee}, ${title}, ${description}, ${c.priority}, 'open',
            ${dueAt(now, c.first_response_sla_mins)}, ${dueAt(now, c.resolution_sla_mins)}, ${now}) returning id`;
  await tx`insert into ticket_messages (tenant_id, ticket_id, author_employee_id, body, is_internal, file_ids, created_at)
           values (${actor.tenant.id}, ${t.id}, ${actor.employeeId}, ${description}, false, ${fileIds}::uuid[], ${now})`;
  const ref = ticketRef(number);
  const notifyIds = assignee ? [assignee] : active.length ? active.map((a) => a.id).filter((id) => id !== actor.employeeId) : await helpdeskAdmins(tx, actor.employeeId);
  for (const id of notifyIds) {
    await notifyEmployee(tx, actor.tenant.id, id, "helpdesk.new", assignee ? `${ref} was assigned to you` : `New ticket in ${c.name}`, `${actor.name}: ${title}`, `/helpdesk?ticket=${t.id}`);
  }
  await audit(tx, actor, t.id, "ticket.raise", { category: c.name, assignee });
  return { id: t.id, number: Number(number), ref, assigneeId: assignee };
}

// ---------- lists ----------
export type TicketListRow = {
  id: string; number: number; ref: string; title: string; category: string; category_id: string; status: TicketStatus; priority: Priority;
  requester: string; requester_id: string; assignee: string | null; assignee_id: string | null; created_at: Date; updated_at: Date; last_activity_at: Date;
  messages: number; sla: ReturnType<typeof slaState>;
};

type ListRaw = Omit<TicketListRow, "number" | "ref" | "sla"> & { number: bigint | number } & Parameters<typeof slaState>[0];

const mapRow = (now: Date) => (r: ListRaw): TicketListRow => ({
  id: r.id, number: Number(r.number), ref: ticketRef(r.number), title: r.title, category: r.category, category_id: r.category_id, status: r.status, priority: r.priority,
  requester: r.requester, requester_id: r.requester_id, assignee: r.assignee, assignee_id: r.assignee_id, created_at: r.created_at, updated_at: r.updated_at,
  last_activity_at: r.last_activity_at, messages: r.messages, sla: slaState(r, now),
});

function listSelect(tx: Tx, agentView: boolean) {
  return tx`
    select t.id, t.number, t.title, c.name as category, t.category_id, t.status, t.priority, rq.display_name as requester, t.raised_by_employee_id as requester_id,
      a.display_name as assignee, t.assignee_employee_id as assignee_id, t.created_at, t.updated_at,
      t.first_response_due_at, t.first_responded_at, t.resolution_due_at, t.closed_at,
      coalesce((select max(m.created_at) from ticket_messages m where m.ticket_id = t.id ${agentView ? tx`` : tx`and not m.is_internal`}), t.created_at) as last_activity_at,
      (select count(*)::int from ticket_messages m where m.ticket_id = t.id ${agentView ? tx`` : tx`and not m.is_internal`}) as messages
    from tickets t join ticket_categories c on c.id = t.category_id join employees rq on rq.id = t.raised_by_employee_id
    left join employees a on a.id = t.assignee_employee_id`;
}

/** The actor's own tickets, newest activity first. */
export async function myTickets(tx: Tx, actor: Actor, now = new Date()) {
  const rows = await tx<ListRaw[]>`${listSelect(tx, false)} where t.raised_by_employee_id = ${actor.employeeId} order by t.status = 'closed', t.updated_at desc limit 200`;
  return rows.map(mapRow(now));
}

export type QueueFilters = { status?: "active" | TicketStatus | "all"; categoryId?: string | null; assignee?: "me" | "unassigned" | "any" | string; breached?: boolean; q?: string };

/** Agent queue: tickets in the actor's categories (all of them for helpdesk admins), never the actor's own. */
export async function queue(tx: Tx, actor: Actor, f: QueueFilters = {}, now = new Date()) {
  const admin = canAdminHelpdesk(actor);
  const status = f.status ?? "active";
  const q = f.q?.trim().slice(0, 80) ?? "";
  const num = /^(hd-?)?0*(\d{1,9})$/i.exec(q)?.[2];
  const like = "%" + q.replace(/[%_\\]/g, "\\$&") + "%";
  const rows = await tx<ListRaw[]>`${listSelect(tx, true)}
    where t.raised_by_employee_id <> ${actor.employeeId}
      ${admin ? tx`` : tx`and (${actor.employeeId}::uuid = any(c.assignee_employee_ids) or c.escalate_to_employee_id = ${actor.employeeId})`}
      ${status === "active" ? tx`and t.status <> 'closed'` : status === "all" ? tx`` : tx`and t.status = ${status}`}
      ${f.categoryId ? tx`and t.category_id = ${f.categoryId}` : tx``}
      ${f.assignee === "me" ? tx`and t.assignee_employee_id = ${actor.employeeId}` : f.assignee === "unassigned" ? tx`and t.assignee_employee_id is null`
        : f.assignee && f.assignee !== "any" ? tx`and t.assignee_employee_id = ${f.assignee}` : tx``}
      ${q ? tx`and (t.title ilike ${like} or rq.display_name ilike ${like} ${num ? tx`or t.number = ${Number(num)}` : tx``})` : tx``}
    order by t.status = 'closed', case t.priority when 'high' then 0 when 'medium' then 1 else 2 end, t.created_at
    limit 300`;
  const out = rows.map(mapRow(now));
  return f.breached ? out.filter((r) => r.sla.breached) : out;
}

/** Counts for the queue header: open, unassigned, mine, breached. */
export function queueCounts(rows: TicketListRow[], actor: Actor) {
  const live = rows.filter((r) => r.status !== "closed");
  return {
    open: live.length,
    unassigned: live.filter((r) => !r.assignee_id).length,
    mine: live.filter((r) => r.assignee_id === actor.employeeId).length,
    breached: live.filter((r) => r.sla.breached).length,
  };
}

// ---------- detail ----------
export type TicketDetail = {
  ticket: TicketListRow & { reopened_count: number; first_responded_at: Date | null; first_response_due_at: Date | null; resolution_due_at: Date | null; closed_at: Date | null };
  messages: { id: string; author: string | null; author_id: string | null; body: string; internal: boolean; created_at: Date; mine: boolean; from_agent: boolean; files: { id: string; name: string; mime: string; size: number }[] }[];
  role: "requester" | "agent";
  can: { reply: boolean; internal: boolean; assign: boolean; actions: TicketAction[] };
  agents: { id: string; name: string; title: string | null }[];
};

export async function ticketDetail(tx: Tx, actor: Actor, id: string, now = new Date()): Promise<TicketDetail | null> {
  const t = await ticketCore(tx, id);
  if (!t) return null;
  const r = roleOn(actor, t);
  if (!r.visible) return null;
  const [row] = await tx<ListRaw[]>`${listSelect(tx, r.agent)} where t.id = ${id}`;
  const msgs = await tx<{ id: string; author: string | null; author_id: string | null; body: string; is_internal: boolean; created_at: Date; file_ids: string[] }[]>`
    select m.id, e.display_name as author, m.author_employee_id as author_id, m.body, m.is_internal, m.created_at, m.file_ids
    from ticket_messages m left join employees e on e.id = m.author_employee_id
    where m.ticket_id = ${id} ${r.agent ? tx`` : tx`and not m.is_internal`} order by m.created_at, m.id`;
  const fileIds = msgs.flatMap((m) => m.file_ids);
  const files = fileIds.length ? await tx<{ id: string; name: string; mime: string; size_bytes: bigint | number }[]>`select id, name, mime, size_bytes from files where id = any(${fileIds}::uuid[])` : [];
  const byId = new Map(files.map((f) => [f.id, { id: f.id, name: f.name, mime: f.mime, size: Number(f.size_bytes) }]));
  const agents = r.agent ? await tx<{ id: string; name: string; title: string | null }[]>`
    select e.id, e.display_name as name, d.title from employees e left join designations d on d.id = e.designation_id
    where e.id = any(${t.agents}::uuid[]) and e.status <> 'relieved' and e.id <> ${t.raised_by_employee_id} order by e.display_name` : [];
  return {
    ticket: { ...mapRow(now)(row), reopened_count: t.reopened_count, first_responded_at: t.first_responded_at, first_response_due_at: t.first_response_due_at, resolution_due_at: t.resolution_due_at, closed_at: t.closed_at },
    messages: msgs.map((m) => ({
      id: m.id, author: m.author, author_id: m.author_id, body: m.body, internal: m.is_internal, created_at: m.created_at, mine: m.author_id === actor.employeeId,
      from_agent: m.author_id !== t.raised_by_employee_id, files: m.file_ids.map((f) => byId.get(f)).filter((f): f is NonNullable<typeof f> => !!f),
    })),
    role: r.agent ? "agent" : "requester",
    can: { reply: t.status !== "closed", internal: r.agent, assign: r.agent && t.status !== "closed", actions: allowedActions(t.status, r.agent ? "agent" : "requester") },
    agents,
  };
}

// ---------- conversation ----------
export async function reply(tx: Tx, actor: Actor, id: string, input: { body: string; internal: boolean; files: UploadedFile[] }, now = new Date()) {
  const t = await ticketCore(tx, id, true);
  const r = t ? roleOn(actor, t) : null;
  if (!t || !r?.visible) throw new AppError("not_found", "Ticket not found.");
  if (input.internal && !r.agent) throw new AppError("forbidden", "Only agents can add internal notes.");
  if (t.status === "closed") throw new AppError("invalid", "This ticket is closed. Reopen it to reply.");
  const body = input.body.trim().slice(0, 5000);
  if (!body) throw new AppError("invalid", "Write a message.", "body");
  const fileIds = await saveAttachments(tx, actor, input.files);
  const [m] = await tx<{ id: string }[]>`
    insert into ticket_messages (tenant_id, ticket_id, author_employee_id, body, is_internal, file_ids, created_at)
    values (${actor.tenant.id}, ${id}, ${actor.employeeId}, ${body}, ${input.internal}, ${fileIds}::uuid[], ${now}) returning id`;
  const ref = ticketRef(t.number);
  if (r.agent && !input.internal) {
    // the first agent answer meets the first-response target and starts the work
    await tx`update tickets set first_responded_at = coalesce(first_responded_at, ${now}), status = case when status = 'open' then 'in_progress' else status end,
             assignee_employee_id = coalesce(assignee_employee_id, ${t.agents.includes(actor.employeeId) ? actor.employeeId : null}::uuid) where id = ${id}`;
    await notifyEmployee(tx, actor.tenant.id, t.raised_by_employee_id, "helpdesk.reply", `New reply on ${ref}`, `${actor.name}: ${body.slice(0, 140)}`, `/me/helpdesk?ticket=${id}`);
  } else {
    await tx`update tickets set updated_at = now() where id = ${id}`;
    if (!input.internal) {
      const to = t.assignee_employee_id ? [t.assignee_employee_id] : t.agents.filter((a) => a !== actor.employeeId);
      for (const a of to) await notifyEmployee(tx, actor.tenant.id, a, "helpdesk.reply", `New reply on ${ref}`, `${actor.name}: ${body.slice(0, 140)}`, `/helpdesk?ticket=${id}`);
    } else if (t.assignee_employee_id && t.assignee_employee_id !== actor.employeeId) {
      await notifyEmployee(tx, actor.tenant.id, t.assignee_employee_id, "helpdesk.note", `Internal note on ${ref}`, `${actor.name}: ${body.slice(0, 140)}`, `/helpdesk?ticket=${id}`);
    }
  }
  return { id: m.id };
}

export async function assign(tx: Tx, actor: Actor, id: string, assigneeId: string | null) {
  const t = await ticketCore(tx, id, true);
  const r = t ? roleOn(actor, t) : null;
  if (!t || !r?.visible) throw new AppError("not_found", "Ticket not found.");
  if (!r.agent) throw new AppError("forbidden", "Only agents can assign tickets.");
  if (t.status === "closed") throw new AppError("invalid", "Reopen the ticket before assigning it.");
  if (assigneeId) {
    if (assigneeId === t.raised_by_employee_id) throw new AppError("invalid", "A ticket can't be assigned to the person who raised it.");
    if (!t.agents.includes(assigneeId)) throw new AppError("invalid", "Pick one of this category's agents.", "assigneeId");
    const [e] = await tx<{ ok: boolean }[]>`select status <> 'relieved' as ok from employees where id = ${assigneeId}`;
    if (!e?.ok) throw new AppError("invalid", "This person has left the company.", "assigneeId");
  }
  if (t.assignee_employee_id === assigneeId) return { changed: false };
  await tx`update tickets set assignee_employee_id = ${assigneeId} where id = ${id}`;
  if (assigneeId && assigneeId !== actor.employeeId) {
    await notifyEmployee(tx, actor.tenant.id, assigneeId, "helpdesk.assigned", `${ticketRef(t.number)} was assigned to you`, t.title, `/helpdesk?ticket=${id}`);
  }
  await audit(tx, actor, id, "ticket.assign", { from: t.assignee_employee_id, to: assigneeId });
  return { changed: true };
}

/** Start work, close or reopen. Guarded on the current status, so a double click can't apply twice. */
export async function changeStatus(tx: Tx, actor: Actor, id: string, action: TicketAction, now = new Date()) {
  const t = await ticketCore(tx, id, true);
  const r = t ? roleOn(actor, t) : null;
  if (!t || !r?.visible) throw new AppError("not_found", "Ticket not found.");
  if (!allowedActions(t.status, r.agent ? "agent" : "requester").includes(action)) {
    throw new AppError("invalid", t.status === "closed" ? "This ticket is already closed." : action === "reopen" ? "This ticket is still open." : "This can't be done on the ticket now.");
  }
  const to = nextStatus(t.status, action)!;
  const res = to === "closed"
    ? await tx`update tickets set status = 'closed', closed_at = ${now} where id = ${id} and status = ${t.status}`
    : to === "open" && action === "reopen"
      ? await tx`update tickets set status = 'open', closed_at = null, reopened_count = reopened_count + 1,
                 resolution_due_at = ${dueAt(now, t.resolution_sla_mins)}, resolution_escalated_at = null where id = ${id} and status = 'closed'`
      : await tx`update tickets set status = ${to} where id = ${id} and status = ${t.status}`;
  if (!res.count) throw new AppError("conflict", "Someone else just changed this ticket. Refresh and try again.");
  const ref = ticketRef(t.number);
  if (r.agent && to === "closed") await notifyEmployee(tx, actor.tenant.id, t.raised_by_employee_id, "helpdesk.closed", `${ref} was closed`, `${t.title}. Reopen it if you still need help.`, `/me/helpdesk?ticket=${id}`);
  if (r.requester && action === "reopen") {
    const to2 = t.assignee_employee_id ? [t.assignee_employee_id] : t.agents;
    for (const a of to2) await notifyEmployee(tx, actor.tenant.id, a, "helpdesk.reopened", `${ref} was reopened`, `${actor.name}: ${t.title}`, `/helpdesk?ticket=${id}`);
  }
  await audit(tx, actor, id, `ticket.${action}`, { from: t.status, to });
  return { status: to };
}

// ---------- attachments ----------
/** May the actor open this ticket attachment? Requesters see files on public messages only; agents see all. */
export async function ticketFileFor(tx: Tx, actor: Actor, fileId: string) {
  const rows = await tx<{ ticket_id: string; is_internal: boolean; storage_key: string; name: string; mime: string }[]>`
    select m.ticket_id, m.is_internal, f.storage_key, f.name, f.mime from ticket_messages m join files f on f.id = ${fileId}
    where ${fileId}::uuid = any(m.file_ids)`;
  for (const row of rows) {
    const t = await ticketCore(tx, row.ticket_id);
    if (!t) continue;
    const r = roleOn(actor, t);
    if (r.agent || (r.requester && !row.is_internal)) return { storage_key: row.storage_key, name: row.name, mime: row.mime };
  }
  return null;
}

// ---------- SLA escalation (jobs:helpdesk) ----------
/**
 * Sends one escalation per breached target (first response, resolution) to the category's escalation contact,
 * the assignee and, when there's no one, the helpdesk admins. Marks the ticket so re-runs don't repeat it.
 */
export async function escalateBreaches(tx: Tx, tenantId: string, now = new Date()) {
  const rows = await tx<(TicketCore & { requester: string })[]>`
    select t.id, t.number, t.title, t.status, t.raised_by_employee_id, t.assignee_employee_id, t.first_response_due_at, t.first_responded_at, t.resolution_due_at, t.closed_at,
      t.first_response_escalated_at, t.resolution_escalated_at, c.name as category, c.assignee_employee_ids as agents, c.escalate_to_employee_id as escalate_to, rq.display_name as requester
    from tickets t join ticket_categories c on c.id = t.category_id join employees rq on rq.id = t.raised_by_employee_id
    where t.status <> 'closed' and ((t.first_response_escalated_at is null and t.first_responded_at is null and t.first_response_due_at < ${now})
                                    or (t.resolution_escalated_at is null and t.resolution_due_at < ${now}))
    for update of t skip locked`;
  let sent = 0;
  for (const t of rows) {
    const due = escalationsDue(t, now);
    if (!due.length) continue;
    const marked = due.includes("first_response") && due.includes("resolution")
      ? await tx`update tickets set first_response_escalated_at = ${now}, resolution_escalated_at = ${now} where id = ${t.id} and first_response_escalated_at is null and resolution_escalated_at is null`
      : due.includes("first_response")
        ? await tx`update tickets set first_response_escalated_at = ${now} where id = ${t.id} and first_response_escalated_at is null`
        : await tx`update tickets set resolution_escalated_at = ${now} where id = ${t.id} and resolution_escalated_at is null`;
    if (!marked.count) continue;
    const people = new Set<string>([t.escalate_to, t.assignee_employee_id].filter((x): x is string => !!x && x !== t.raised_by_employee_id));
    if (!people.size) for (const a of await helpdeskAdmins(tx, t.raised_by_employee_id)) people.add(a);
    const what = due.length === 2 ? "first response and resolution targets" : due[0] === "first_response" ? "first response target" : "resolution target";
    for (const p of people) {
      await notifyEmployee(tx, tenantId, p, "helpdesk.sla_breach", `${ticketRef(t.number)} missed its ${what}`, `${t.category} · ${t.requester}: ${t.title}`, `/helpdesk?ticket=${t.id}`);
    }
    const [tp] = await tx<{ priority: string }[]>`select priority from tickets where id = ${t.id}`;
    await emitEvent(tx, tenantId, "ticket.breached", { employeeId: t.raised_by_employee_id, occurrence: `${t.id}:${due.join("+")}`, link: `/helpdesk?ticket=${t.id}`,
      facts: { "ticket.priority": tp?.priority ?? null, "ticket.category": t.category }, vars: { "ticket.number": ticketRef(t.number), "ticket.title": t.title, "ticket.category": t.category } });
    sent += 1;
  }
  return sent;
}
