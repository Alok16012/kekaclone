import "server-only";
import { createHash } from "node:crypto";
import { AppError, withTenant, type Tx } from "@/server/db";
import { sql } from "@/server/db";
import type { Tenant } from "@/server/auth/session";
import { actorForEmployee } from "@/server/auth/system-actor";
import { appUrl, deliverQueued } from "@/server/email";
import { decryptField } from "@/server/modules/payroll/secret";
import { signAction, slackApprovalMessage, teamsApprovalCard, verifyAction, type ApprovalMessage } from "./chat-rules";
import { deliverWebhooks } from "./service";

/*
 * Approvals from Slack and Teams. When a step becomes pending, the connected channel gets a message:
 *   Slack  — Block Kit buttons whose values are signed one-use tokens; Slack posts the press to /api/chat/slack,
 *            verified with SLACK_SIGNING_SECRET (without it, the message has only an "Open in erp" link).
 *   Teams  — an Adaptive Card whose Approve / Decline buttons open a signed confirm page (/api/chat/act) in erp.
 * The token names the tenant, step and approver; acting runs the normal decide() as that approver, so the
 * step's guard (pending, this approver) still applies and nothing can be decided twice.
 */

const chatScope = (tenantId: string, provider: string) => [tenantId, "integration", provider];
const TOKEN_DAYS = 7;

/** Signing key for action tokens: derived from ERP_DATA_KEY (dev fallback mirrors payroll/secret). */
export function actionSecret() {
  const raw = process.env.ERP_DATA_KEY?.trim() || (process.env.NODE_ENV === "production" ? "" : "erp-local-development-key-do-not-use-in-production");
  if (!raw) throw new Error("ERP_DATA_KEY is not set.");
  return createHash("sha256").update(`chat-approvals|${raw}`).digest("hex");
}

export function chatApprovalStatus() {
  return { slackInteractive: !!process.env.SLACK_SIGNING_SECRET?.trim(), slackHint: "SLACK_SIGNING_SECRET in .env.local (from your Slack app's Basic Information) and the Interactivity request URL set to https://<any workspace>.<root>/api/chat/slack" };
}

type ChatPoster = (url: string, body: unknown) => Promise<number>;
const chatPost: ChatPoster = async (url, body) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) })).status;

/** Post "approval needed" with buttons to every connected channel. Best effort; never fails the request. */
export async function notifyChatApproval(tx: Tx, tenantId: string, a: { stepId: string; approverId: string; approverName: string; requesterName: string; summary: string }, post: ChatPoster = chatPost) {
  const rows = await tx<{ provider: "slack" | "teams"; config_enc: Uint8Array }[]>`select provider, config_enc from integrations where provider in ('slack', 'teams')`;
  if (!rows.length) return 0;
  const [t] = await tx<{ subdomain: string }[]>`select subdomain::text from tenants where id = ${tenantId}`;
  const exp = Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400;
  const secret = actionSecret();
  const approveToken = signAction(secret, { t: tenantId, s: a.stepId, a: a.approverId, d: "approved", e: exp });
  const declineToken = signAction(secret, { t: tenantId, s: a.stepId, a: a.approverId, d: "rejected", e: exp });
  const base: ApprovalMessage = { summary: a.summary, requester: a.requesterName, approver: a.approverName, approveToken, declineToken, actUrl: appUrl(t.subdomain, "/api/chat/act"), inboxUrl: appUrl(t.subdomain, "/inbox") };
  let sent = 0;
  for (const r of rows) {
    let ok = false;
    try {
      const url = decryptField(r.config_enc, chatScope(tenantId, r.provider));
      const body = r.provider === "slack"
        ? slackApprovalMessage(chatApprovalStatus().slackInteractive ? base : { ...base, approveToken: null, declineToken: null })
        : teamsApprovalCard(base);
      const status = await post(url, body);
      ok = status >= 200 && status < 300;
    } catch { ok = false; }
    await tx`update integrations set status = ${ok ? "connected" : "error"} where provider = ${r.provider}`;
    if (ok) sent++;
  }
  return sent;
}

export type ChatActResult = { ok: true; message: string; decision: "approved" | "rejected"; summary: string } | { ok: false; message: string };

/** Verify a token and decide the step as the named approver. Used by both the Slack and the Teams routes. */
export async function actOnChatToken(token: string | null, comment: string, now = new Date()): Promise<ChatActResult> {
  const a = verifyAction(actionSecret(), token, Math.floor(now.getTime() / 1000));
  if (!a) return { ok: false, message: "This approval link is invalid or has expired. Open your Inbox in erp instead." };
  const [t] = await sql<{ id: string; name: string; status: string; subdomain: string; plan: Tenant["plan"] }[]>`select id, name, status, subdomain::text, plan from tenants where id = ${a.t}`;
  if (!t) return { ok: false, message: "This workspace no longer exists." };
  const tenant: Tenant = { id: t.id, name: t.name, status: t.status, subdomain: t.subdomain, plan: t.plan };
  try {
    const r = await withTenant(t.id, async (tx) => {
      const actor = await actorForEmployee(tx, tenant, a.a);
      if (!actor) throw new AppError("forbidden", "The approver on this link no longer has an active account.");
      const [step] = await tx<{ summary: string }[]>`select r.summary from approval_steps s join approval_requests r on r.id = s.request_id where s.id = ${a.s}`;
      if (!step) throw new AppError("not_found", "This request no longer exists.");
      const { decide } = await import("@/server/modules/approvals/service");
      await decide(tx, actor, a.s, a.d, comment || `via ${a.d === "approved" ? "chat approval" : "chat decline"}`);
      return { summary: step.summary, approver: actor.name };
    });
    await deliverQueued(t.id).catch(() => {});
    await deliverWebhooks(t.id).catch(() => {});
    return { ok: true, decision: a.d, summary: r.summary, message: `${r.summary} — ${a.d === "approved" ? "approved" : "declined"} by ${r.approver}.` };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, message: e.message };
    console.error(e);
    return { ok: false, message: "Something went wrong. Open your Inbox in erp instead." };
  }
}
