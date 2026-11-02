import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { audit } from "@/server/modules/audit/service";
import { todayIn, type ISODate } from "@/lib/dates";
import { MAX_QUICK_LINKS, validateQuickLink } from "./rules";

const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/** Quick links show on everyone's Home: a company-wide setting (settings.org without a scope). */
export const canEditQuickLinks = (actor: Actor) => canFor(actor, "settings.org", EVERYWHERE);
const assertEdit = (actor: Actor) => { if (!canEditQuickLinks(actor)) throw new AppError("forbidden", "You don't have access to do this."); };

export type QuickLink = { id: string; label: string; url: string };

export async function quickLinks(tx: Tx): Promise<QuickLink[]> {
  return tx<QuickLink[]>`select id, label, url from quick_links order by position, created_at limit ${MAX_QUICK_LINKS}`;
}

export async function saveQuickLink(tx: Tx, actor: Actor, id: string | null, input: { label: string; url: string }) {
  assertEdit(actor);
  const v = validateQuickLink(input);
  if (!v.ok) throw new AppError("invalid", v.error, v.field);
  if (id) {
    const [r] = await tx<{ id: string }[]>`update quick_links set label = ${v.label}, url = ${v.url} where id = ${id} returning id`;
    if (!r) throw new AppError("not_found", "Link not found.");
    await audit(tx, actor, { entityType: "quick_link", entityId: id, action: "update", diff: { label: v.label, url: v.url } });
    return r;
  }
  await tx`select pg_advisory_xact_lock(hashtext('quick_links:' || ${actor.tenant.id}))`;   // two admins adding at once can't pass 18
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from quick_links`;
  if (n >= MAX_QUICK_LINKS) throw new AppError("invalid", `You can have up to ${MAX_QUICK_LINKS} quick links. Remove one first.`);
  const [r] = await tx<{ id: string }[]>`insert into quick_links (tenant_id, label, url, position) values (${actor.tenant.id}, ${v.label}, ${v.url}, ${n}) returning id`;
  await audit(tx, actor, { entityType: "quick_link", entityId: r.id, action: "create", diff: { label: v.label, url: v.url } });
  return r;
}

export async function deleteQuickLink(tx: Tx, actor: Actor, id: string) {
  assertEdit(actor);
  const [r] = await tx<{ label: string }[]>`delete from quick_links where id = ${id} returning label`;
  if (!r) throw new AppError("not_found", "Link not found.");
  await audit(tx, actor, { entityType: "quick_link", entityId: id, action: "delete", diff: { label: r.label } });
}

export async function moveQuickLink(tx: Tx, actor: Actor, id: string, dir: "up" | "down") {
  assertEdit(actor);
  const rows = await tx<{ id: string }[]>`select id from quick_links order by position, created_at`;
  const i = rows.findIndex((r) => r.id === id), j = dir === "up" ? i - 1 : i + 1;
  if (i < 0) throw new AppError("not_found", "Link not found.");
  if (j < 0 || j >= rows.length) return;
  [rows[i], rows[j]] = [rows[j], rows[i]];
  for (const [pos, r] of rows.entries()) await tx`update quick_links set position = ${pos} where id = ${r.id}`;
}

export type RemotePerson = { id: string; name: string; designation: string | null; kind: "wfh" | "on_duty"; half: string | null };

/** People working from home or on duty today (approved requests), for the Home widget. */
export async function remoteToday(tx: Tx, today: ISODate = todayIn()): Promise<RemotePerson[]> {
  return tx<RemotePerson[]>`
    select distinct on (e.id) e.id, e.display_name as name, d.title as designation, r.kind, r.payload->>'half' as half
    from attendance_requests r join employees e on e.id = r.employee_id and e.status in ('active', 'notice')
    left join designations d on d.id = e.designation_id
    where r.status = 'approved' and r.kind in ('wfh', 'on_duty') and ${today}::date between r.from_date and r.to_date
    order by e.id, r.kind`;
}
