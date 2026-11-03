"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as integ from "@/server/modules/integrations/service";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });

const keyInput = z.object({ name: z.string().max(80), scopes: z.array(z.string()).max(10) });
export async function createApiKeyAction(raw: z.input<typeof keyInput>) {
  const p = keyInput.safeParse(raw);
  if (!p.success) return bad("Check the key details.");
  return runAction((tx, actor) => integ.createApiKey(tx, actor, p.data));
}
export async function revokeApiKeyAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Key not found.");
  return runAction((tx, actor) => integ.revokeApiKey(tx, actor, id));
}

const endpointInput = z.object({ url: z.string().max(500), events: z.array(z.string()).max(10) });
export async function createEndpointAction(raw: z.input<typeof endpointInput>) {
  const p = endpointInput.safeParse(raw);
  if (!p.success) return bad("Check the endpoint details.");
  return runAction((tx, actor) => integ.createEndpoint(tx, actor, p.data));
}
export async function setEndpointActiveAction(id: string, active: boolean) {
  if (!uuid.safeParse(id).success) return bad("Endpoint not found.");
  return runAction((tx, actor) => integ.setEndpointActive(tx, actor, id, !!active));
}
export async function deleteEndpointAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Endpoint not found.");
  return runAction((tx, actor) => integ.deleteEndpoint(tx, actor, id));
}
export async function sendTestEventAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Endpoint not found.");
  return runAction((tx, actor) => integ.sendTestEvent(tx, actor, id));
}
export async function retryDeliveryAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Delivery not found.");
  return runAction((tx, actor) => integ.retryDelivery(tx, actor, id));
}
export async function listDeliveriesAction(endpointId: string) {
  if (!uuid.safeParse(endpointId).success) return bad("Endpoint not found.");
  return runAction((tx, actor) => integ.listDeliveries(tx, actor, endpointId), { refresh: false });
}
