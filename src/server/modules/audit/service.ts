import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { assertCan } from "@/server/auth/permissions";
import { MASTERS, type MasterKind } from "@/server/modules/settings/org";
import { decodeCursor, describe, encodeCursor, formatWhen, type AuditFilters } from "./rules";

/** One audit row. `actor` may be null for system work (scheduled job changes, signup). */
export async function audit(tx: Tx, who: { tenantId: string; userId: string | null } | Actor, e: { entityType: string; entityId?: string | null; action: string; diff?: unknown }) {
  const tenantId = "tenant" in who ? who.tenant.id : who.tenantId;
  const userId = who.userId;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${tenantId}, ${userId}, ${e.entityType}, ${e.entityId ?? null}, ${e.action}, ${e.diff === undefined ? null : tx.json(e.diff as never)})`;
}

export type AuditItem = {
  id: string; at: string; actor_user_id: string | null; actor_name: string | null; actor_email: string | null;
  entity_type: string; entity_id: string | null; action: string; diff: unknown; ip: string | null;
  entity_label: string | null; subject_label: string | null; description: string; when: string;
};

const PAGE = 50;
const tz = "Asia/Kolkata";

/** Resolve display names for a page of rows: one query per entity type present, whitelisted tables only. */
async function labels(tx: Tx, rows: { entity_type: string; entity_id: string | null; diff: unknown }[]) {
  const byType = new Map<string, Set<string>>();
  const add = (t: string, id: unknown) => { if (typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) { if (!byType.has(t)) byType.set(t, new Set()); byType.get(t)!.add(id); } };
  for (const r of rows) {
    add(r.entity_type, r.entity_id);
    const d = (r.diff ?? {}) as Record<string, unknown>;
    add("employee", d.employeeId);
  }
  const out = new Map<string, string>();
  const put = (t: string, rs: { id: string; label: string | null }[]) => { for (const r of rs) if (r.label) out.set(`${t}:${r.id}`, r.label); };
  for (const [t, set] of byType) {
    const ids = [...set];
    if (t === "employee") put(t, await tx<{ id: string; label: string }[]>`select id, display_name as label from employees where id = any(${ids}::uuid[])`);
    else if (t === "user") put(t, await tx<{ id: string; label: string }[]>`select u.id, coalesce(e.display_name, u.email::text) as label from users u left join employees e on e.user_id = u.id where u.id = any(${ids}::uuid[])`);
    else if (t === "role") put(t, await tx<{ id: string; label: string }[]>`select id, name as label from roles where id = any(${ids}::uuid[])`);
    else if (t === "tenant") put(t, await tx<{ id: string; label: string }[]>`select id, name as label from tenants where id = any(${ids}::uuid[])`);
    else if (t === "leave") put(t, await tx<{ id: string; label: string }[]>`select r.id, e.display_name as label from leave_requests r join employees e on e.id = r.employee_id where r.id = any(${ids}::uuid[])`);
    else if (t === "profile_change") put(t, await tx<{ id: string; label: string }[]>`select r.id, e.display_name as label from profile_change_requests r join employees e on e.id = r.employee_id where r.id = any(${ids}::uuid[])`);
    else if (t === "attendance_request") put(t, await tx<{ id: string; label: string }[]>`select r.id, e.display_name as label from attendance_requests r join employees e on e.id = r.employee_id where r.id = any(${ids}::uuid[])`);
    else if (t === "leave_plan") put(t, await tx<{ id: string; label: string }[]>`select id, name as label from leave_plans where id = any(${ids}::uuid[])`);
    else if (t in MASTERS) {
      const m = MASTERS[t as MasterKind];
      put(t, await tx<{ id: string; label: string }[]>`select id, ${tx(m.nameCol)} as label from ${tx(m.table)} where id = any(${ids}::uuid[])`);
    }
  }
  // things that no longer exist (a deleted role or department): fall back to the last name the log recorded
  const missing = rows.filter((r) => r.entity_id && !out.has(`${r.entity_type}:${r.entity_id}`));
  if (missing.length) {
    const past = await tx<{ entity_type: string; entity_id: string; name: string }[]>`
      select distinct on (entity_type, entity_id) entity_type, entity_id, diff->>'name' as name from audit_logs
      where entity_id = any(${missing.map((r) => r.entity_id!)}::uuid[]) and jsonb_typeof(diff->'name') = 'string'
      order by entity_type, entity_id, (action = 'delete') desc, created_at desc`;
    for (const p of past) if (!out.has(`${p.entity_type}:${p.entity_id}`)) out.set(`${p.entity_type}:${p.entity_id}`, p.name);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Names for ids that appear inside diffs (managers, departments …) so the diff viewer can show words, not uuids. */
async function refNames(tx: Tx, diffs: unknown[]): Promise<Record<string, string>> {
  const ids = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || ids.size > 500) return;
    if (typeof v === "string") { if (UUID_RE.test(v)) ids.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  for (const d of diffs) walk(d, 0);
  if (!ids.size) return {};
  const list = [...ids];
  const rows = await tx<{ id: string; label: string }[]>`
    select id, display_name as label from employees where id = any(${list}::uuid[])
    union all select id, name from departments where id = any(${list}::uuid[])
    union all select id, title from designations where id = any(${list}::uuid[])
    union all select id, name from locations where id = any(${list}::uuid[])
    union all select id, name from legal_entities where id = any(${list}::uuid[])
    union all select id, name from business_units where id = any(${list}::uuid[])
    union all select id, name from bands where id = any(${list}::uuid[])
    union all select id, name from roles where id = any(${list}::uuid[])`;
  return Object.fromEntries(rows.map((r) => [r.id, r.label]));
}

/** The audit trail, newest first, 50 at a time. Filters: actor (user id), entity type, action, IST date range. */
export async function listAudit(tx: Tx, actor: Actor, f: AuditFilters, cursor?: string | null, limit = PAGE) {
  assertCan(actor, "settings.audit");
  const c = decodeCursor(cursor);
  const rows = await tx<Omit<AuditItem, "entity_label" | "subject_label" | "description" | "when">[]>`
    select a.id, to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
           a.actor_user_id, coalesce(e.display_name, u.email::text) as actor_name, u.email::text as actor_email,
           a.entity_type, a.entity_id, a.action, a.diff, host(a.ip) as ip
    from audit_logs a
    left join users u on u.id = a.actor_user_id
    left join employees e on e.user_id = a.actor_user_id
    where true
      ${f.actor ? tx`and a.actor_user_id = ${f.actor}` : tx``}
      ${f.entity ? tx`and a.entity_type = ${f.entity}` : tx``}
      ${f.action ? tx`and a.action = ${f.action}` : tx``}
      ${f.from ? tx`and a.created_at >= (${f.from}::date)::timestamp at time zone ${tz}` : tx``}
      ${f.to ? tx`and a.created_at < (${f.to}::date + 1)::timestamp at time zone ${tz}` : tx``}
      ${c ? tx`and (a.created_at, a.id) < (${c.at}::timestamptz, ${c.id}::uuid)` : tx``}
    order by a.created_at desc, a.id desc
    limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const names = await labels(tx, page);
  const items: AuditItem[] = page.map((r) => {
    const d = (r.diff ?? {}) as Record<string, unknown>;
    const entity_label = (r.entity_id && names.get(`${r.entity_type}:${r.entity_id}`)) || (typeof d.name === "string" ? d.name : typeof d.label === "string" ? d.label : null);
    const subject_label = typeof d.employeeId === "string" ? names.get(`employee:${d.employeeId}`) ?? null : null;
    return { ...r, entity_label, subject_label, description: describe({ ...r, entity_label, subject_label, actor_label: r.actor_name }), when: formatWhen(r.at) };
  });
  const last = page[page.length - 1];
  return { items, refs: await refNames(tx, page.map((r) => r.diff)), nextCursor: rows.length > limit && last ? encodeCursor({ at: last.at, id: last.id }) : null };
}

export type SignInItem = { id: string; at: string; when: string; user_id: string | null; name: string | null; email: string | null; method: string; success: boolean; ip: string | null; user_agent: string | null };

/** Sign-in attempts (successful and failed), newest first. */
export async function listSignIns(tx: Tx, actor: Actor, f: AuditFilters & { result?: "success" | "failure" | null }, cursor?: string | null, limit = PAGE) {
  assertCan(actor, "settings.audit");
  const c = decodeCursor(cursor);
  const rows = await tx<Omit<SignInItem, "when">[]>`
    select l.id, to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, l.user_id,
           coalesce(e.display_name, u.email::text) as name, coalesce(l.email::text, u.email::text) as email, l.method, l.success, host(l.ip) as ip, l.user_agent
    from login_events l left join users u on u.id = l.user_id left join employees e on e.user_id = l.user_id
    where true
      ${f.actor ? tx`and l.user_id = ${f.actor}` : tx``}
      ${f.result === "success" ? tx`and l.success` : f.result === "failure" ? tx`and not l.success` : tx``}
      ${f.from ? tx`and l.created_at >= (${f.from}::date)::timestamp at time zone ${tz}` : tx``}
      ${f.to ? tx`and l.created_at < (${f.to}::date + 1)::timestamp at time zone ${tz}` : tx``}
      ${c ? tx`and (l.created_at, l.id) < (${c.at}::timestamptz, ${c.id}::uuid)` : tx``}
    order by l.created_at desc, l.id desc
    limit ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map((r): SignInItem => ({ ...r, when: formatWhen(r.at) })), nextCursor: rows.length > limit && last ? encodeCursor({ at: last.at, id: last.id }) : null };
}

/** Options for the filter bar: people with an account, and the entity types / actions that actually occur. */
export async function auditFilterOptions(tx: Tx, actor: Actor) {
  assertCan(actor, "settings.audit");
  const [people, entities, actions] = await Promise.all([
    tx<{ id: string; name: string; title: string | null }[]>`
      select u.id, coalesce(e.display_name, u.email::text) as name, d.title from users u
      left join employees e on e.user_id = u.id left join designations d on d.id = e.designation_id order by 2`,
    tx<{ entity_type: string }[]>`select distinct entity_type from audit_logs order by 1`,
    tx<{ action: string }[]>`select distinct action from audit_logs order by 1`,
  ]);
  return { people, entities: entities.map((r) => r.entity_type), actions: actions.map((r) => r.action) };
}
