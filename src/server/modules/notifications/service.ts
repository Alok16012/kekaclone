import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { assertCan } from "@/server/auth/permissions";
import { queueEmail, appUrl } from "@/server/email";
import { notificationEmail } from "@/server/email/templates";
import { simpleEmail } from "@/server/email/simple";
import { channelsFor, eventFor, NOTIFICATION_EVENTS, validateChannels, type Channel } from "./events";
import { defaultTemplate, isTemplateEvent, renderTemplate, SAMPLE_VARS, TEMPLATE_EVENTS, validateTemplate, type Template } from "./templates";
import { queuePush } from "@/server/modules/push/service";

export type NotificationRow = { id: string; kind: string; title: string; body: string | null; link: string | null; read: boolean; created_at: string };

/** Newest first; `before` (an ISO timestamp) pages back through older ones. */
export async function listNotifications(tx: Tx, actor: Actor, before?: string, limit = 30) {
  const rows = await tx<(Omit<NotificationRow, "read" | "created_at"> & { read_at: Date | null; created_at: Date })[]>`
    select id, kind, title, body, link, read_at, created_at from notifications
    where user_id = ${actor.userId} and (${before ?? null}::timestamptz is null or created_at < ${before ?? null}::timestamptz)
    order by created_at desc limit ${limit + 1}`;
  return {
    items: rows.slice(0, limit).map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, read: !!r.read_at, created_at: r.created_at.toISOString() })),
    hasMore: rows.length > limit,
  };
}

export async function unreadCount(tx: Tx, actor: Actor) {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${actor.userId} and read_at is null`;
  return n;
}

/** Mark some (or all, when ids is null) of the actor's own notifications as read. */
export async function markRead(tx: Tx, actor: Actor, ids: string[] | null) {
  if (ids) await tx`update notifications set read_at = now() where user_id = ${actor.userId} and id = any(${ids}::uuid[]) and read_at is null`;
  else await tx`update notifications set read_at = now() where user_id = ${actor.userId} and read_at is null`;
  return unreadCount(tx, actor);
}

// ---------------------------------------------------------------- sending (in-app + email per tenant settings)


type Recipient = { employee_id: string; user_id: string; email: string; name: string };

async function tenantInfo(tx: Tx, tenantId: string) {
  const [t] = await tx<{ name: string; subdomain: string }[]>`select name, subdomain::text from tenants where id = ${tenantId}`;
  return t ?? { name: "erp", subdomain: "app" };
}

async function storedChannels(tx: Tx, kind: string): Promise<Channel[] | null> {
  const [r] = await tx<{ channels: Channel[] }[]>`select channels from notification_settings where event = ${kind}`;
  return r?.channels ?? null;
}

/**
 * Tell people something: an in-app notification and/or an email, by the tenant's per-event settings
 * (Settings → Notifications). Emails are queued in the same transaction and go out after commit.
 * One row per recipient; people without an account are skipped.
 */
export async function notify(tx: Tx, tenantId: string, employeeIds: string[], kind: string, title: string, body: string, link: string) {
  const ids = [...new Set(employeeIds)];
  if (!ids.length) return { inApp: 0, emails: 0 };
  const channels = channelsFor(kind, await storedChannels(tx, kind));
  if (!channels.length) return { inApp: 0, emails: 0 };
  const people = await tx<Recipient[]>`
    select e.id as employee_id, u.id as user_id, u.email::text as email, e.display_name as name
    from employees e join users u on u.id = e.user_id where e.id = any(${ids}::uuid[]) and u.status = 'active'`;
  let inApp = 0, emails = 0;
  if (channels.includes("in_app")) {
    const r = await tx`insert into notifications (tenant_id, user_id, kind, title, body, link)
                       select ${tenantId}, u, ${kind}, ${title}, ${body}, ${link} from unnest(${people.map((p) => p.user_id)}::uuid[]) as u`;
    inApp = r.count;
    await queuePush(tx, tenantId, people.map((p) => p.user_id), { title, body, url: link });   // Web Push, delivered after commit
  }
  if (channels.includes("email")) {
    const t = await tenantInfo(tx, tenantId);
    const stored = await storedTemplate(tx, kind);
    for (const p of people) {
      await queueEmail(tx, tenantId, { kind, to: p.email, ...buildEmail(stored, { company: t.name, name: p.name, title, body, url: appUrl(t.subdomain, link), eventLabel: eventFor(kind).label }) });
      emails++;
    }
  }
  return { inApp, emails };
}

/** The tenant's saved template for an event, or null for the built-in one. */
async function storedTemplate(tx: Tx, kind: string): Promise<Template | null> {
  const [r] = await tx<Template[]>`select subject, body from notification_templates where event = ${kind}`;
  return r ?? null;
}

/** Saved template → rendered email; otherwise the standard notification email. */
function buildEmail(stored: Template | null, p: { company: string; name: string; title: string; body: string; url: string; eventLabel: string }) {
  if (!stored) return notificationEmail(p);
  const r = renderTemplate(stored, { first_name: p.name.split(" ")[0], name: p.name, company: p.company, title: p.title, body: p.body, link: p.url, event: p.eventLabel });
  return simpleEmail({ company: p.company, subject: r.subject, heading: p.title, paragraphs: r.paragraphs, button: { label: "Open in erp", url: p.url },
    footnote: `You're getting this because of your account at ${p.company}. An admin can change which events are emailed under Settings → Notifications.` });
}

/** Email the people who already got an in-app row by a direct insert (announcements): respects the event's email toggle. */
export async function emailOnly(tx: Tx, tenantId: string, employeeIds: string[], kind: string, title: string, body: string, link: string) {
  const channels = channelsFor(kind, await storedChannels(tx, kind));
  if (!channels.includes("email") || !employeeIds.length) return 0;
  const people = await tx<Recipient[]>`
    select e.id as employee_id, u.id as user_id, u.email::text as email, e.display_name as name
    from employees e join users u on u.id = e.user_id where e.id = any(${employeeIds}::uuid[]) and u.status = 'active'`;
  const t = await tenantInfo(tx, tenantId);
  const stored = await storedTemplate(tx, kind);
  for (const p of people) await queueEmail(tx, tenantId, { kind, to: p.email, ...buildEmail(stored, { company: t.name, name: p.name, title, body, url: appUrl(t.subdomain, link), eventLabel: eventFor(kind).label }) });
  return people.length;
}

// ---------------------------------------------------------------- settings (Settings → Notifications)

export type EventSetting = { key: string; label: string; in_app: boolean; email: boolean; emailOnly: boolean; isDefault: boolean };

export async function notificationSettings(tx: Tx): Promise<{ group: string; events: EventSetting[] }[]> {
  const rows = await tx<{ event: string; channels: Channel[] }[]>`select event, channels from notification_settings`;
  const stored = new Map(rows.map((r) => [r.event, r.channels]));
  return NOTIFICATION_EVENTS.map((g) => ({
    group: g.group,
    events: g.events.map((e) => {
      const ch = channelsFor(e.key, stored.get(e.key));
      return { key: e.key, label: e.label, in_app: ch.includes("in_app"), email: ch.includes("email"), emailOnly: !!e.emailOnly, isDefault: !stored.has(e.key) };
    }),
  }));
}

export async function setNotificationChannels(tx: Tx, actor: Actor, event: string, channels: unknown) {
  assertCan(actor, "settings.notifications");
  const ch = validateChannels(event, channels);
  if (!ch) throw new AppError("invalid", "Unknown notification event or channel.");
  const final = channelsFor(event, ch);
  await tx`insert into notification_settings (tenant_id, event, channels) values (${actor.tenant.id}, ${event}, ${final}::text[])
           on conflict (tenant_id, event) do update set channels = excluded.channels`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${actor.tenant.id}, ${actor.userId}, 'notification_setting', ${actor.tenant.id}, 'update', ${tx.json({ event, channels: final })})`;
  return final;
}

// ---------------------------------------------------------------- email templates (Settings → Notifications → Email templates)

export type TemplateRow = { key: string; label: string; subject: string; body: string; isDefault: boolean; updated_at: string | null };

export async function emailTemplates(tx: Tx): Promise<{ group: string; templates: TemplateRow[] }[]> {
  const rows = await tx<{ event: string; subject: string; body: string; updated_at: Date }[]>`select event, subject, body, updated_at from notification_templates`;
  const stored = new Map(rows.map((r) => [r.event, r]));
  return TEMPLATE_EVENTS.map((g) => ({
    group: g.group,
    templates: g.events.map((e) => {
      const s = stored.get(e.key), d = defaultTemplate(e.key);
      return { key: e.key, label: e.label, subject: s?.subject ?? d.subject, body: s?.body ?? d.body, isDefault: !s, updated_at: s?.updated_at.toISOString() ?? null };
    }),
  }));
}

export async function saveEmailTemplate(tx: Tx, actor: Actor, event: string, raw: unknown) {
  assertCan(actor, "settings.notifications");
  if (!isTemplateEvent(event)) throw new AppError("invalid", "Unknown notification event.");
  const v = validateTemplate(raw);
  if (!v.ok) throw new AppError("invalid", v.message, v.field);
  await tx`insert into notification_templates (tenant_id, event, subject, body, updated_by) values (${actor.tenant.id}, ${event}, ${v.value.subject}, ${v.value.body}, ${actor.userId})
           on conflict (tenant_id, event) do update set subject = excluded.subject, body = excluded.body, updated_by = excluded.updated_by`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'notification_template', ${actor.tenant.id}, 'update', ${tx.json({ event, subject: v.value.subject })})`;
}

/** Back to the built-in template (deletes the saved one). */
export async function resetEmailTemplate(tx: Tx, actor: Actor, event: string) {
  assertCan(actor, "settings.notifications");
  if (!isTemplateEvent(event)) throw new AppError("invalid", "Unknown notification event.");
  const r = await tx`delete from notification_templates where event = ${event}`;
  if (r.count) await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'notification_template', ${actor.tenant.id}, 'reset', ${tx.json({ event })})`;
  return defaultTemplate(event);
}

/** What the email would look like with sample values (no sending). */
export function previewEmailTemplate(actor: Actor, raw: unknown) {
  const v = validateTemplate(raw);
  if (!v.ok) throw new AppError("invalid", v.message, v.field);
  const vars = { ...SAMPLE_VARS, company: actor.tenant.name, name: actor.name, first_name: actor.name.split(" ")[0] };
  const r = renderTemplate(v.value, vars);
  return { subject: r.subject, paragraphs: r.paragraphs, html: simpleEmail({ company: actor.tenant.name, subject: r.subject, heading: vars.title, paragraphs: r.paragraphs, button: { label: "Open in erp", url: vars.link } }).html };
}
