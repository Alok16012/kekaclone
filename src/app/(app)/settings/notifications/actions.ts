"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { setNotificationChannels } from "@/server/modules/notifications/service";

const input = z.object({ event: z.string().max(60), channels: z.array(z.enum(["in_app", "email"])).max(2) });

/** Settings → Notifications: which channels an event uses for this company. */
export async function setNotificationChannelsAction(raw: z.input<typeof input>) {
  const p = input.safeParse(raw);
  if (!p.success) return { ok: false as const, error: "Unknown event or channel." };
  return runAction((tx, actor) => setNotificationChannels(tx, actor, p.data.event, p.data.channels));
}
