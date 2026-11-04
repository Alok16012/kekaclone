import "server-only";
import { randomUUID } from "node:crypto";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { assertFeature, EVERYWHERE, hasFeature } from "@/server/modules/saas/gate";
import { notify } from "@/server/modules/notifications/service";
import { queueEmail, appUrl } from "@/server/email";
import { simpleEmail } from "@/server/email/simple";
import { encryptField } from "@/server/modules/payroll/secret";
import { endpointUrlProblem } from "@/server/modules/integrations/rules";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import {
  dailyDue, dedupeKey, matches, render, triggerKind, validateAutomation,
  type Action, type AutomationInput, type Condition, type Facts, type Recipient, type Trigger, type TriggerConfig,
} from "./rules";

/*
 * Settings → Automations. Two entry points run automations:
 *   emitEvent(tx, tenantId, trigger, …)    the in-process event bus; modules call it inside the mutation's transaction
 *   runDaily(tx, tenantId, today)          birthdays, anniversaries and "N days before/after a date", from jobs:daily
 * Each automation runs inside a savepoint, so one failing action never breaks the mutation that triggered it, and
 * every (automation, occurrence) pair runs once (automation_runs.dedupe_key).
 */

const ownRoot = () => (process.env.ROOT_DOMAIN ?? "").split(":")[0] || null;

export const canManageAutomations = (actor: Actor) => canFor(actor, "automations.manage", EVERYWHERE);
function assertManage(actor: Actor) {
  if (!canManageAutomations(actor)) throw new AppError("forbidden", "Only admins for the whole company can change automations.");
}

export type AutomationRow = AutomationInput & { id: string; run_count: number; last_run_at: string | null; created_at: string; created_by_name: string | null };

export async function listAutomations(tx: Tx, actor: Actor): Promise<AutomationRow[]> {
  assertManage(actor);
  const rows = await tx<(Omit<AutomationRow, "last_run_at" | "created_at"> & { last_run_at: Date | null; created_at: Date })[]>`
    select a.id, a.name, a.trigger, a.trigger_config, a.conditions, a.actions, a.is_active, a.run_count, a.last_run_at, a.created_at, e.display_name as created_by_name
    from automations a left join employees e on e.user_id = a.created_by order by a.created_at desc`;
  return rows.map((r) => ({ ...r, last_run_at: r.last_run_at?.toISOString() ?? null, created_at: r.created_at.toISOString() }));
}

export async function saveAutomation(tx: Tx, actor: Actor, id: string | null, raw: unknown) {
  assertManage(actor);
  assertFeature(actor, "workflow_builder");
  const v = validateAutomation(raw);
  if (!v.ok) throw new AppError("invalid", v.problem.message, v.problem.field);
  const a = v.value;
  for (const act of a.actions) {
    if (act.type === "group") { const [g] = await tx`select 1 from groups where id = ${act.group_id}`; if (!g) throw new AppError("invalid", "Add to group: that group doesn't exist.", "actions"); }
    if (act.type === "webhook") { const problem = endpointUrlProblem(act.url, ownRoot()); if (problem) throw new AppError("invalid", `Webhook: ${problem}`, "actions"); }
    for (const r of recipientsOf(act)) if (r.startsWith("employee:")) { const [e] = await tx`select 1 from employees where id = ${r.slice(9)} and status <> 'relieved'`; if (!e) throw new AppError("invalid", "One of the people picked no longer works here.", "actions"); }
  }
  if (id) {
    const [row] = await tx<{ id: string }[]>`update automations set name = ${a.name}, trigger = ${a.trigger}, trigger_config = ${tx.json(a.trigger_config as never)}, conditions = ${tx.json(a.conditions as never)}, actions = ${tx.json(a.actions as never)}, is_active = ${a.is_active} where id = ${id} returning id`;
    if (!row) throw new AppError("not_found", "That automation doesn't exist.");
    await audit(tx, actor, { entityType: "automation", entityId: id, action: "update", diff: { name: a.name, trigger: a.trigger } });
    return id;
  }
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from automations`;
  if (n >= 50) throw new AppError("invalid", "You can have up to 50 automations.");
  const [row] = await tx<{ id: string }[]>`insert into automations (tenant_id, name, trigger, trigger_config, conditions, actions, is_active, created_by)
    values (${actor.tenant.id}, ${a.name}, ${a.trigger}, ${tx.json(a.trigger_config as never)}, ${tx.json(a.conditions as never)}, ${tx.json(a.actions as never)}, ${a.is_active}, ${actor.userId}) returning id`;
  await audit(tx, actor, { entityType: "automation", entityId: row.id, action: "create", diff: { name: a.name, trigger: a.trigger } });
  return row.id;
}

export async function setAutomationActive(tx: Tx, actor: Actor, id: string, active: boolean) {
  assertManage(actor);
  const [row] = await tx<{ name: string }[]>`update automations set is_active = ${active} where id = ${id} returning name`;
  if (!row) throw new AppError("not_found", "That automation doesn't exist.");
  await audit(tx, actor, { entityType: "automation", entityId: id, action: active ? "enable" : "disable", diff: { name: row.name } });
}

export async function deleteAutomation(tx: Tx, actor: Actor, id: string) {
  assertManage(actor);
  const [row] = await tx<{ name: string }[]>`delete from automations where id = ${id} returning name`;
  if (!row) throw new AppError("not_found", "That automation doesn't exist.");
  await audit(tx, actor, { entityType: "automation", entityId: id, action: "delete", diff: { name: row.name } });
}

export type RunRow = { id: string; automation: string; trigger: string; subject: string | null; status: string; result: Record<string, unknown>; created_at: string };

export async function runLog(tx: Tx, actor: Actor, automationId?: string, limit = 50): Promise<RunRow[]> {
  assertManage(actor);
  const rows = await tx<(Omit<RunRow, "created_at"> & { created_at: Date })[]>`
    select r.id, a.name as automation, r.trigger, e.display_name as subject, r.status, r.result, r.created_at
    from automation_runs r join automations a on a.id = r.automation_id left join employees e on e.id = r.subject_employee_id
    where ${automationId ? tx`r.automation_id = ${automationId}` : tx`true`} order by r.created_at desc limit ${limit}`;
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}

/** Options the editor needs: departments, locations, …, groups, people with roles. */
export async function editorOptions(tx: Tx, actor: Actor) {
  assertManage(actor);
  const [departments, locations, designations, legalEntities, businessUnits, groups, roles, people] = await Promise.all([
    tx<{ id: string; name: string }[]>`select id, name from departments order by name`,
    tx<{ id: string; name: string }[]>`select id, name from locations order by name`,
    tx<{ id: string; name: string }[]>`select id, title as name from designations order by title`,
    tx<{ id: string; name: string }[]>`select id, name from legal_entities order by name`,
    tx<{ id: string; name: string }[]>`select id, name from business_units order by name`,
    tx<{ id: string; name: string }[]>`select g.id, t.name || ' · ' || g.name as name from groups g join group_types t on t.id = g.group_type_id order by 2`,
    tx<{ key: string; name: string }[]>`select key, name from roles order by is_system desc, name`,
    tx<{ id: string; name: string }[]>`select id, display_name as name from employees where status <> 'relieved' order by display_name limit 500`,
  ]);
  return { departments, locations, designations, legalEntities, businessUnits, groups, roles, people, allowed: hasFeature(actor, "workflow_builder") };
}

// ---------------------------------------------------------------- running

type Person = {
  id: string; display_name: string; first_name: string; work_email: string; employee_number: string; joining_date: string; dob: string | null; probation_end_date: string | null; exit_date: string | null;
  department_id: string | null; location_id: string | null; designation_id: string | null; legal_entity_id: string | null; business_unit_id: string | null; manager_id: string | null; l2_manager_id: string | null;
  worker_type: string; time_type: string; probation_status: string; status: string; department: string | null; designation: string | null; location: string | null; manager_name: string | null;
};

async function person(tx: Tx, employeeId: string): Promise<Person | null> {
  const [p] = await tx<Person[]>`
    select e.id, e.display_name, e.first_name, e.work_email::text, e.employee_number, e.joining_date::text, e.dob::text, e.probation_end_date::text, e.exit_date::text,
           e.department_id, e.location_id, e.designation_id, e.legal_entity_id, e.business_unit_id, e.manager_id, e.l2_manager_id, e.worker_type, e.time_type, e.probation_status, e.status,
           d.name as department, g.title as designation, l.name as location, m.display_name as manager_name
    from employees e left join departments d on d.id = e.department_id left join designations g on g.id = e.designation_id left join locations l on l.id = e.location_id left join employees m on m.id = e.manager_id
    where e.id = ${employeeId}`;
  return p ?? null;
}

const recipientsOf = (a: Action): Recipient[] => (a.type === "notify" || a.type === "email" ? a.to : a.type === "task" ? [a.to] : []);

async function resolveRecipients(tx: Tx, who: Recipient[], p: Person): Promise<string[]> {
  const out = new Set<string>();
  for (const r of who) {
    if (r === "employee") out.add(p.id);
    else if (r === "manager" && p.manager_id) out.add(p.manager_id);
    else if (r === "l2_manager" && p.l2_manager_id) out.add(p.l2_manager_id);
    else if (r === "hr_admins" || r.startsWith("role:")) {
      const key = r === "hr_admins" ? "hr_admin" : r.slice(5);
      for (const x of await tx<{ id: string }[]>`select ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved' where ro.key = ${key}`) out.add(x.id);
    } else if (r.startsWith("employee:")) out.add(r.slice(9));
  }
  return [...out];
}

type Ctx = { tenantId: string; tenantName: string; subdomain: string; today: ISODate; p: Person; facts: Facts; vars: Record<string, string | number | null | undefined>; link: string };

async function runAction(tx: Tx, c: Ctx, a: Action): Promise<Record<string, unknown>> {
  switch (a.type) {
    case "notify": {
      const ids = await resolveRecipients(tx, a.to, c.p);
      const r = await notify(tx, c.tenantId, ids, "automation", render(a.title, c.vars), render(a.body, c.vars), c.link);
      return { notified: r.inApp, emails: r.emails };
    }
    case "email": {
      const ids = await resolveRecipients(tx, a.to, c.p);
      const people = await tx<{ email: string; name: string }[]>`select u.email::text as email, e.display_name as name from employees e join users u on u.id = e.user_id where e.id = any(${ids}::uuid[]) and u.status = 'active'`;
      for (const x of people) {
        await queueEmail(tx, c.tenantId, { kind: "automation", to: x.email, ...simpleEmail({ company: c.tenantName, subject: render(a.subject, c.vars), heading: render(a.subject, c.vars), paragraphs: render(a.body, c.vars).split(/\n{2,}/).filter(Boolean), button: { label: "Open erp", url: appUrl(c.subdomain, c.link) } }) });
      }
      return { emails: people.length };
    }
    case "task": {
      const [owner] = await resolveRecipients(tx, [a.to], c.p);
      if (!owner) return { task: "no owner" };
      const [t] = await tx<{ id: string }[]>`insert into tasks (tenant_id, subject_employee_id, assignee_employee_id, title, type, due_date) values (${c.tenantId}, ${c.p.id}, ${owner}, ${render(a.title, c.vars)}, 'simple', ${addDaysISO(c.today, a.due_days)}) returning id`;
      await notify(tx, c.tenantId, [owner], "automation", "New task", `${render(a.title, c.vars)} · due ${addDaysISO(c.today, a.due_days)}`, "/me/tasks");
      return { task: t.id };
    }
    case "group": {
      const r = await tx`insert into employee_groups (tenant_id, employee_id, group_id) select ${c.tenantId}, ${c.p.id}, id from groups where id = ${a.group_id} on conflict do nothing`;
      return { added: r.count };
    }
    case "announcement": {
      const [author] = await tx<{ id: string }[]>`select ra.employee_id as id from role_assignments ra join roles ro on ro.id = ra.role_id join employees e on e.id = ra.employee_id and e.status <> 'relieved' where ro.key = 'global_admin' order by ra.created_at limit 1`;
      if (!author) return { announcement: "no admin to post as" };
      const [post] = await tx<{ id: string }[]>`insert into posts (tenant_id, author_employee_id, kind, title, body) values (${c.tenantId}, ${author.id}, 'announcement', ${render(a.title, c.vars)}, ${render(a.body, c.vars)}) returning id`;
      // tell the audience now, the same way a posted announcement does (otherwise it waits for the next publish run)
      await (await import("@/server/modules/engage/service")).publishDue(tx, c.tenantId);
      return { announcement: post.id };
    }
    case "webhook": {
      // saved before the private-network check existed, or the root changed since: never queue a call to an internal address
      const problem = endpointUrlProblem(a.url, ownRoot());
      if (problem) return { webhook: `refused: ${problem}` };
      let [w] = await tx<{ id: string }[]>`select id from webhook_endpoints where kind = 'automation' and url = ${a.url}`;
      if (!w) {
        const id = randomUUID();
        await tx`insert into webhook_endpoints (id, tenant_id, url, events, secret_enc, is_active, kind, label) values (${id}, ${c.tenantId}, ${a.url}, '{}', ${encryptField(`whsec_auto_${randomUUID().replace(/-/g, "")}`, [c.tenantId, "webhook", id])}, true, 'automation', 'Automation')`;
        w = { id };
      }
      const eventId = randomUUID();
      const body = { id: eventId, type: `automation.${String(c.facts.trigger)}`, created_at: new Date().toISOString(), data: { employee_id: c.p.id, ...c.vars } };
      await tx`insert into webhook_deliveries (tenant_id, endpoint_id, event, event_id, payload, next_attempt_at) values (${c.tenantId}, ${w.id}, ${body.type}, ${eventId}, ${tx.json(body as never)}, now())`;
      return { webhook: eventId };
    }
  }
}

type Matching = { id: string; name: string; trigger: Trigger; trigger_config: TriggerConfig; conditions: Condition[]; actions: Action[] };

async function runOne(tx: Tx, c: Ctx, a: Matching, key: string) {
  const [claimed] = await tx<{ id: string }[]>`insert into automation_runs (tenant_id, automation_id, trigger, subject_employee_id, dedupe_key, status) values (${c.tenantId}, ${a.id}, ${a.trigger}, ${c.p.id}, ${key}, 'ok') on conflict (automation_id, dedupe_key) do nothing returning id`;
  if (!claimed) return "skipped" as const;   // already ran for this occurrence
  const results: Record<string, unknown>[] = [];
  let failed: string | null = null;
  try {
    await tx.savepoint(async (sp) => { for (const act of a.actions) results.push({ type: act.type, ...(await runAction(sp as unknown as Tx, c, act)) }); });
  } catch (e) { failed = (e instanceof Error ? e.message : String(e)).slice(0, 300); }
  await tx`update automation_runs set status = ${failed ? "failed" : "ok"}, result = ${tx.json((failed ? { error: failed, done: results } : { done: results }) as never)} where id = ${claimed.id}`;
  await tx`update automations set run_count = run_count + 1, last_run_at = now() where id = ${a.id}`;
  return failed ? ("failed" as const) : ("ok" as const);
}

async function tenantBits(tx: Tx, tenantId: string) {
  const [t] = await tx<{ name: string; subdomain: string }[]>`select name, subdomain::text from tenants where id = ${tenantId}`;
  return t ?? { name: "erp", subdomain: "app" };
}

function baseVars(p: Person, t: { name: string }, today: ISODate): Record<string, string | number | null> {
  return {
    "employee.name": p.display_name, "employee.first_name": p.first_name, "employee.email": p.work_email, "employee.number": p.employee_number, "employee.department": p.department,
    "employee.designation": p.designation, "employee.location": p.location, "employee.joining_date": p.joining_date, "manager.name": p.manager_name, company: t.name, date: today,
  };
}
function baseFacts(p: Person): Facts {
  return { department_id: p.department_id, location_id: p.location_id, designation_id: p.designation_id, legal_entity_id: p.legal_entity_id, business_unit_id: p.business_unit_id, worker_type: p.worker_type, time_type: p.time_type, probation_status: p.probation_status };
}

export type EventInput = {
  employeeId: string;
  /** the occurrence (request id, ticket id + target, …): the same id never runs an automation twice */
  occurrence: string;
  facts?: Facts;
  vars?: Record<string, string | number | null | undefined>;
  link?: string;
};

/**
 * The event bus: run every active automation for this trigger whose conditions match. Call inside the mutation's
 * transaction; it never throws for an automation's own failure (recorded in the run log instead).
 */
export async function emitEvent(tx: Tx, tenantId: string, trigger: Trigger, input: EventInput) {
  if (triggerKind(trigger) !== "event") throw new Error(`${trigger} is a daily trigger`);
  const autos = await tx<Matching[]>`select id, name, trigger, trigger_config, conditions, actions from automations where trigger = ${trigger} and is_active order by created_at`;
  if (!autos.length) return { matched: 0, ran: 0 };
  const p = await person(tx, input.employeeId);
  if (!p) return { matched: 0, ran: 0 };
  const t = await tenantBits(tx, tenantId);
  const today = todayIn();
  const c: Ctx = { tenantId, tenantName: t.name, subdomain: t.subdomain, today, p, facts: { ...baseFacts(p), ...input.facts, trigger }, vars: { ...baseVars(p, t, today), ...input.vars }, link: input.link ?? `/org/employees/${p.id}` };
  let matched = 0, ran = 0;
  for (const a of autos) {
    if (!matches(a.conditions, c.facts)) continue;
    matched++;
    if ((await runOne(tx, c, a, dedupeKey(p.id, input.occurrence))) === "ok") ran++;
  }
  return { matched, ran };
}

/** Daily triggers for every active person: birthdays, anniversaries, date offsets. From jobs:daily (idempotent per day). */
export async function runDaily(tx: Tx, tenantId: string, today: ISODate = todayIn()) {
  const autos = await tx<Matching[]>`select id, name, trigger, trigger_config, conditions, actions from automations where trigger in ('birthday','work_anniversary','date_offset') and is_active order by created_at`;
  if (!autos.length) return { matched: 0, ran: 0 };
  const t = await tenantBits(tx, tenantId);
  const people = await tx<{ id: string }[]>`select id from employees where status in ('active','notice','preboarding')`;
  let matched = 0, ran = 0;
  for (const { id } of people) {
    let p: Person | null = null;
    for (const a of autos) {
      p ??= await person(tx, id);
      if (!p) break;
      const due = dailyDue(a.trigger, a.trigger_config ?? {}, p, today);
      if (!due) continue;
      const c: Ctx = { tenantId, tenantName: t.name, subdomain: t.subdomain, today, p, facts: { ...baseFacts(p), ...due, trigger: a.trigger }, vars: { ...baseVars(p, t, today), ...due }, link: `/org/employees/${p.id}` };
      if (!matches(a.conditions, c.facts)) continue;
      matched++;
      if ((await runOne(tx, c, a, dedupeKey(p.id, today))) === "ok") ran++;
    }
  }
  return { matched, ran };
}
