import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { assertCan } from "@/server/auth/permissions";
import type { MfaMode } from "@/server/modules/auth/mfa";

export async function securitySettings(tx: Tx, actor: Actor) {
  const [t] = await tx<{ mfa: MfaMode | null }[]>`select auth_settings->>'mfa' as mfa from tenants`;
  const [me] = await tx<{ mfa_enabled: boolean }[]>`select mfa_enabled from users where id = ${actor.userId}`;
  return { mode: (t.mfa ?? "optional") as MfaMode, mine: me.mfa_enabled };
}

export async function setMfaMode(tx: Tx, actor: Actor, mode: MfaMode) {
  assertCan(actor, "settings.security");
  if (!["off", "optional", "required"].includes(mode)) throw new AppError("invalid", "Unknown setting.");
  await tx`update tenants set auth_settings = jsonb_set(auth_settings, '{mfa}', to_jsonb(${mode}::text)) where id = ${actor.tenant.id}`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'tenant', ${actor.tenant.id}, 'security.mfa', ${tx.json({ mode })})`;
}

export async function setMyMfa(tx: Tx, actor: Actor, on: boolean) {
  await tx`update users set mfa_enabled = ${on} where id = ${actor.userId}`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'user', ${actor.userId}, 'security.my_mfa', ${tx.json({ on })})`;
}
