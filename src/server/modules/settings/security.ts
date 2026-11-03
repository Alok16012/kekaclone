import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { assertCan } from "@/server/auth/permissions";
import type { MfaMode } from "@/server/modules/auth/mfa";
import { domainAllowed, invalidAllowEntries, ipAllowed, normalizeSessionHours, readAuthSettings, type AuthSettings } from "@/server/auth/network-rules";
import { assertFeature, assertWorkspace, hasFeature } from "@/server/modules/saas/gate";
import { ssoProviderStatus } from "@/server/modules/auth/oidc";
import { smsProviderStatus } from "@/server/sms";
import { audit } from "@/server/modules/audit/service";

export async function securitySettings(tx: Tx, actor: Actor) {
  const [t] = await tx<{ auth_settings: unknown }[]>`select auth_settings from tenants`;
  const a = readAuthSettings(t.auth_settings);
  const [me] = await tx<{ mfa_enabled: boolean }[]>`select mfa_enabled from users where id = ${actor.userId}`;
  return {
    mode: (a.mfa ?? "optional") as MfaMode, mine: me.mfa_enabled,
    sessionHours: a.session_hours, ipAllowlist: a.ip_allowlist,
    sso: { google: a.google, microsoft: a.microsoft, domains: a.sso_domains, ssoOnly: a.sso_only === true, microsoftTenant: a.microsoft_tenant ?? "", providers: ssoProviderStatus() },
    mobileOtp: { enabled: a.mobile_otp, provider: smsProviderStatus() },
    features: { sso: hasFeature(actor, "sso"), ipAllowlist: hasFeature(actor, "ip_allowlist"), mobileOtp: hasFeature(actor, "mobile_otp") },
  };
}

async function patchAuth(tx: Tx, actor: Actor, patch: Partial<AuthSettings>, action: string) {
  assertWorkspace(actor, "settings.security");
  await tx`update tenants set auth_settings = auth_settings || ${tx.json(patch as never)} where id = ${actor.tenant.id}`;
  await audit(tx, actor, { entityType: "tenant", entityId: actor.tenant.id, action, diff: patch });
}

/** How long a sign-in lasts. Existing sessions keep their original expiry. */
export async function setSessionHours(tx: Tx, actor: Actor, hours: number) {
  const h = normalizeSessionHours(hours);
  if (h !== hours) throw new AppError("invalid", "Pick one of the listed session lengths.");
  await patchAuth(tx, actor, { session_hours: h }, "security.session");
}

/**
 * Restrict sign-in to some networks. The admin's own address must be in the list (when it is known), so a typo
 * can't lock the company out; an empty list removes the restriction.
 */
export async function setIpAllowlist(tx: Tx, actor: Actor, raw: string[], adminIp: string | null) {
  const list = [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
  if (list.length) assertFeature(actor, "ip_allowlist");
  const bad = invalidAllowEntries(list);
  if (bad.length) throw new AppError("invalid", `These entries aren't valid addresses or ranges: ${bad.join(", ")}`, "ip_allowlist");
  if (list.length > 50) throw new AppError("invalid", "Keep the allowlist to 50 entries.");
  if (list.length && adminIp && !ipAllowed(adminIp, list)) throw new AppError("invalid", `Your current address (${adminIp}) isn't in the list, so this would lock you out. Add it first.`, "ip_allowlist");
  await patchAuth(tx, actor, { ip_allowlist: list }, "security.ip_allowlist");
}

export async function setSso(tx: Tx, actor: Actor, input: { google: boolean; microsoft: boolean; domains: string[]; ssoOnly: boolean; microsoftTenant: string }) {
  if (input.google || input.microsoft) assertFeature(actor, "sso");
  const status = ssoProviderStatus();
  if (input.google && !status.google.configured) throw new AppError("invalid", "Google sign-in isn't configured on this server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
  if (input.microsoft && !status.microsoft.configured) throw new AppError("invalid", "Microsoft sign-in isn't configured on this server yet (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET).");
  const domains = [...new Set(input.domains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
  if (domains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw new AppError("invalid", "Enter domains like acme.in, one per line.", "domains");
  if (domains.length && !domainAllowed(actor.email, domains)) throw new AppError("invalid", `Your own email (${actor.email}) isn't on one of these domains, so you couldn't sign in with SSO. Add it first.`, "domains");
  if (input.ssoOnly && !input.google && !input.microsoft) throw new AppError("invalid", "Turn on at least one provider before requiring SSO.");
  const microsoftTenant = input.microsoftTenant.trim();
  if (input.microsoft && !microsoftTenant) throw new AppError("invalid", "Enter your Entra directory id or domain (e.g. acme.onmicrosoft.com); Microsoft sign-in only trusts accounts from your own directory.", "microsoftTenant");
  if (microsoftTenant && !/^[a-z0-9.-]{1,80}$/i.test(microsoftTenant)) throw new AppError("invalid", "The Microsoft tenant should be an id or a domain like acme.onmicrosoft.com.", "microsoftTenant");
  await patchAuth(tx, actor, { google: input.google, microsoft: input.microsoft, sso_domains: domains, sso_only: input.ssoOnly, password: !input.ssoOnly, microsoft_tenant: microsoftTenant || undefined }, "security.sso");
}

export async function setMobileOtp(tx: Tx, actor: Actor, on: boolean) {
  if (on) assertFeature(actor, "mobile_otp");
  await patchAuth(tx, actor, { mobile_otp: on }, "security.mobile_otp");
}

export async function setMfaMode(tx: Tx, actor: Actor, mode: MfaMode) {
  assertCan(actor, "settings.security");
  assertWorkspace(actor, "settings.security");
  if (!["off", "optional", "required"].includes(mode)) throw new AppError("invalid", "Unknown setting.");
  await tx`update tenants set auth_settings = jsonb_set(auth_settings, '{mfa}', to_jsonb(${mode}::text)) where id = ${actor.tenant.id}`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'tenant', ${actor.tenant.id}, 'security.mfa', ${tx.json({ mode })})`;
}

export async function setMyMfa(tx: Tx, actor: Actor, on: boolean) {
  await tx`update users set mfa_enabled = ${on} where id = ${actor.userId}`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'user', ${actor.userId}, 'security.my_mfa', ${tx.json({ on })})`;
}
