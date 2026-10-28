import "server-only";
import { AppError, withTenant, type Tx } from "@/server/db";
import type { Actor, Tenant } from "@/server/auth/session";
import { hashPassword, newToken, sha256 } from "@/server/auth/password";
import { passwordProblem } from "@/server/auth/password-policy";
import { accessTo } from "@/server/modules/employees/profile";
import { appUrl, deliverQueued, queueEmail } from "@/server/email";
import { inviteEmail, passwordChangedEmail, resetEmail } from "@/server/email/templates";

const INVITE_DAYS = 7, RESET_MINUTES = 60;

/** Send (or re-send) invites. Older invite links stop working. Already-active people are skipped with a reason. */
export async function invite(tx: Tx, actor: Actor, employeeIds: string[]) {
  const sent: string[] = [], skipped: { name: string; reason: string }[] = [];
  for (const id of employeeIds) {
    const [p] = await tx<{ user_id: string | null; display_name: string; work_email: string; status: string; user_status: string | null }[]>`
      select e.user_id, e.display_name, e.work_email, e.status, u.status as user_status from employees e left join users u on u.id = e.user_id where e.id = ${id}`;
    if (!p) continue;
    if ((await accessTo(tx, actor, id)) !== "admin") { skipped.push({ name: p.display_name, reason: "outside the people you manage" }); continue; }
    if (p.status === "relieved") { skipped.push({ name: p.display_name, reason: "has left the company" }); continue; }
    if (!p.user_id || p.user_status === "active") { skipped.push({ name: p.display_name, reason: "already signed in before" }); continue; }
    if (p.user_status === "disabled") { skipped.push({ name: p.display_name, reason: "login is disabled" }); continue; }
    await tx`update auth_tokens set consumed_at = now() where user_id = ${p.user_id} and purpose = 'invite' and consumed_at is null`;
    const token = newToken();
    await tx`insert into auth_tokens (tenant_id, user_id, purpose, target, token_hash, expires_at)
             values (${actor.tenant.id}, ${p.user_id}, 'invite', ${p.work_email}, ${sha256(token)}, now() + make_interval(days => ${INVITE_DAYS}))`;
    await tx`update users set invited_at = now() where id = ${p.user_id}`;
    const mail = inviteEmail({ company: actor.tenant.name, name: p.display_name, inviter: actor.name, url: appUrl(actor.tenant.subdomain, `/auth/invite?t=${token}`), days: INVITE_DAYS });
    await queueEmail(tx, actor.tenant.id, { kind: "invite", to: p.work_email, ...mail });
    sent.push(p.display_name);
  }
  if (sent.length) await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'user', 'invite', ${tx.json({ count: sent.length })})`;
  return { sent: sent.length, skipped };
}

type TokenRow = { id: string; user_id: string; email: string; name: string };

async function findToken(tx: Tx, token: string, purpose: "invite" | "reset_password") {
  const [t] = await tx<TokenRow[]>`
    select t.id, t.user_id, u.email, coalesce(e.display_name, u.email) as name
    from auth_tokens t join users u on u.id = t.user_id left join employees e on e.user_id = u.id
    where t.token_hash = ${sha256(token)} and t.purpose = ${purpose} and t.consumed_at is null and t.expires_at > now()`;
  return t ?? null;
}

/** For the set-password page: who the link is for, or null if it's expired/used. */
export async function tokenInfo(tenant: Tenant, token: string, purpose: "invite" | "reset_password") {
  return withTenant(tenant.id, async (tx) => {
    const t = await findToken(tx, token, purpose);
    return t ? { name: t.name, email: t.email } : null;
  });
}

/** Set the password from an invite or reset link. Returns the user id so the caller can sign them in. */
export async function setPasswordWithToken(tenant: Tenant, token: string, purpose: "invite" | "reset_password", password: string) {
  const userId = await withTenant(tenant.id, async (tx) => {
    const t = await findToken(tx, token, purpose);
    if (!t) throw new AppError("invalid", purpose === "invite" ? "This invite link has expired or was already used. Ask HR to send a new one." : "This reset link has expired or was already used. Request a new one.");
    const problem = passwordProblem(password, t.email);
    if (problem) throw new AppError("invalid", problem, "password");
    await tx`update users set password_hash = ${await hashPassword(password)}, status = 'active', email_verified_at = coalesce(email_verified_at, now()),
             failed_logins = 0, locked_until = null where id = ${t.user_id}`;
    await tx`update auth_tokens set consumed_at = now() where user_id = ${t.user_id} and purpose in ('invite', 'reset_password') and consumed_at is null`;
    if (purpose === "reset_password") {
      await tx`delete from sessions where user_id = ${t.user_id}`;   // sign out everywhere
      await queueEmail(tx, tenant.id, { kind: "password_changed", to: t.email, ...passwordChangedEmail({ company: tenant.name, name: t.name }) });
    }
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action) values (${tenant.id}, ${t.user_id}, 'user', ${t.user_id}, ${purpose === "invite" ? "invite_accepted" : "password_reset"})`;
    return t.user_id;
  });
  await deliverQueued(tenant.id).catch(() => {});
  return userId;
}

/**
 * Forgot password. Always looks the same from outside (no "email not found"), and sends at most
 * 3 links per 15 minutes per person.
 */
export async function requestReset(tenant: Tenant, email: string) {
  await withTenant(tenant.id, async (tx) => {
    const [u] = await tx<{ id: string; name: string; email: string }[]>`
      select u.id, coalesce(e.display_name, u.email) as name, u.email from users u left join employees e on e.user_id = u.id
      where u.email = ${email.trim().toLowerCase()} and u.status = 'active'`;
    if (!u) return;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from auth_tokens where user_id = ${u.id} and purpose = 'reset_password' and created_at > now() - interval '15 minutes'`;
    if (n >= 3) return;
    const token = newToken();
    await tx`insert into auth_tokens (tenant_id, user_id, purpose, target, token_hash, expires_at)
             values (${tenant.id}, ${u.id}, 'reset_password', ${u.email}, ${sha256(token)}, now() + make_interval(mins => ${RESET_MINUTES}))`;
    await queueEmail(tx, tenant.id, { kind: "reset_password", to: u.email, ...resetEmail({ company: tenant.name, name: u.name, url: appUrl(tenant.subdomain, `/auth/reset?t=${token}`), minutes: RESET_MINUTES }) });
  });
  await deliverQueued(tenant.id).catch(() => {});
}
