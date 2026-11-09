"use server";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { runAction } from "@/server/action";
import { disconnectCalendar, isCalendarProvider } from "@/server/modules/calendar/service";
import { subscribePush, unsubscribePush } from "@/server/modules/push/service";
import { isLocale, LOCALE_COOKIE } from "@/i18n";
import { LOCALE_COOKIE_OPTIONS } from "@/i18n/server";

const bad = (error: string) => ({ ok: false as const, error });

export async function disconnectCalendarAction(provider: string) {
  if (!isCalendarProvider(provider)) return bad("Unknown calendar provider.");
  return runAction((tx, actor) => disconnectCalendar(tx, actor, provider));
}

const sub = z.object({ endpoint: z.string().max(2000), keys: z.object({ p256dh: z.string().max(400), auth: z.string().max(200) }) });
export async function subscribePushAction(raw: z.input<typeof sub>) {
  const p = sub.safeParse(raw);
  if (!p.success) return bad("The browser didn't give a usable push subscription.");
  const ua = (await headers()).get("user-agent");
  return runAction((tx, actor) => subscribePush(tx, actor, p.data, ua));
}
export async function unsubscribePushAction(endpoint: string) {
  if (typeof endpoint !== "string" || endpoint.length > 2000) return bad("Unknown device.");
  return runAction((tx, actor) => unsubscribePush(tx, actor, endpoint));
}

/** Per-user language: saved on the account and mirrored in a cookie the pages read. */
export async function setLocaleAction(locale: string) {
  if (!isLocale(locale)) return bad("Unknown language.");
  const r = await runAction(async (tx, actor) => {
    await tx`update users set locale = ${locale} where id = ${actor.userId}`;
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'user', ${actor.userId}, 'locale', ${tx.json({ locale })})`;
  }, { refresh: false });
  if (r.ok) (await cookies()).set(LOCALE_COOKIE, locale, LOCALE_COOKIE_OPTIONS);
  return r;
}
