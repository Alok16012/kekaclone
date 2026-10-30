import { getActor } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { pendingAcks } from "@/server/modules/documents/service";
import { AckInterstitial } from "./ack-gate";

/**
 * Server half of the policy gate: blocking documents the signed-in person hasn't acknowledged yet.
 * Rendered from app/(app)/template.tsx inside its own Suspense boundary, so pages never wait for it.
 */
export async function AckGate() {
  const actor = await getActor();
  if (!actor) return null;
  const docs = (await withTenant(actor.tenant.id, (tx) => pendingAcks(tx, actor))).filter((d) => d.blocking);
  if (!docs.length) return null;
  return <AckInterstitial docs={docs.map((d) => ({ id: d.id, title: d.title, description: d.description, file_id: d.file_id, file_name: d.file_name, folder: d.folder }))} />;
}
