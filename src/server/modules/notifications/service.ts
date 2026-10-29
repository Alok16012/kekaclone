import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";

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
