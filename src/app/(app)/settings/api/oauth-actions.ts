"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { createOAuthClient, revokeOAuthClient } from "@/server/modules/integrations/oauth";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const clientInput = z.object({ name: z.string().max(80), scopes: z.array(z.string()).max(12) });

/** Settings → API & webhooks → OAuth2 clients (plat2). */
export async function createOAuthClientAction(raw: z.input<typeof clientInput>) {
  const p = clientInput.safeParse(raw);
  if (!p.success) return bad("Check the client details.");
  return runAction((tx, actor) => createOAuthClient(tx, actor, p.data));
}
export async function revokeOAuthClientAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Client not found.");
  return runAction((tx, actor) => revokeOAuthClient(tx, actor, id));
}
