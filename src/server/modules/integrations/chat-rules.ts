/**
 * Slack / Teams approvals: the parts with no I/O. Signed one-use action tokens, Slack request verification,
 * and the message shapes (Slack Block Kit, Teams Adaptive Card). Pure, so they are unit-tested.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type ChatAction = { t: string; s: string; a: string; d: "approved" | "rejected"; e: number };
const b64 = (b: Buffer) => b.toString("base64url");
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest();

/** token = base64url(json).base64url(hmac). Carries the tenant, step, approver and decision; expires. */
export function signAction(secret: string, a: ChatAction): string {
  const body = b64(Buffer.from(JSON.stringify(a), "utf8"));
  return `${body}.${b64(hmac(secret, body))}`;
}

export function verifyAction(secret: string, token: string | null | undefined, nowSec: number): ChatAction | null {
  if (!token || token.length > 2000) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64(hmac(secret, body));
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const a = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ChatAction;
    if (!a || typeof a.t !== "string" || typeof a.s !== "string" || typeof a.a !== "string" || (a.d !== "approved" && a.d !== "rejected") || typeof a.e !== "number") return null;
    if (a.e < nowSec) return null;
    return a;
  } catch { return null; }
}

/** Slack signs requests as v0=hmac(secret, "v0:<ts>:<body>"); replayed or stale requests (> 5 min) are refused. */
export function verifySlackSignature(signingSecret: string, timestamp: string | null, body: string, header: string | null, nowSec: number, toleranceSec = 300) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec || !header) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

export type ApprovalMessage = { summary: string; requester: string; approver: string; approveToken: string | null; declineToken: string | null; actUrl: string | null; inboxUrl: string };

/** Slack: text + buttons when interactive approvals are configured, otherwise text with a link to the Inbox. */
export function slackApprovalMessage(m: ApprovalMessage) {
  const text = `Approval needed: ${m.summary} (from ${m.requester}) — waiting for ${m.approver}`;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*Approval needed*\n${m.summary}\nFrom ${m.requester} · waiting for ${m.approver}` } },
  ];
  if (m.approveToken && m.declineToken) {
    blocks.push({ type: "actions", block_id: "erp_approval", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approve", value: m.approveToken },
      { type: "button", style: "danger", text: { type: "plain_text", text: "Decline" }, action_id: "decline", value: m.declineToken },
      { type: "button", text: { type: "plain_text", text: "Open in erp" }, action_id: "open", url: m.inboxUrl },
    ] });
  } else {
    blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in erp" }, action_id: "open", url: m.inboxUrl }] });
  }
  return { text, blocks };
}

/** Teams: an Adaptive Card whose buttons open a signed confirm page in erp. */
export function teamsApprovalCard(m: ApprovalMessage) {
  const actions: unknown[] = [];
  if (m.actUrl && m.approveToken && m.declineToken) {
    actions.push({ type: "Action.OpenUrl", title: "Approve", url: `${m.actUrl}?token=${encodeURIComponent(m.approveToken)}` });
    actions.push({ type: "Action.OpenUrl", title: "Decline", url: `${m.actUrl}?token=${encodeURIComponent(m.declineToken)}` });
  }
  actions.push({ type: "Action.OpenUrl", title: "Open in erp", url: m.inboxUrl });
  return {
    type: "message",
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: {
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
      body: [
        { type: "TextBlock", text: "Approval needed", weight: "Bolder", size: "Medium" },
        { type: "TextBlock", text: m.summary, wrap: true },
        { type: "TextBlock", text: `From ${m.requester} · waiting for ${m.approver}`, isSubtle: true, wrap: true },
      ],
      actions,
    } }],
  };
}

/** What the Slack interactive payload gives us: the pressed button's value (our token) and action id. */
export function slackPressedAction(payload: unknown): { actionId: string; value: string | null } | null {
  const p = payload as { type?: string; actions?: { action_id?: string; value?: string }[] };
  if (!p || p.type !== "block_actions" || !Array.isArray(p.actions) || !p.actions[0]) return null;
  return { actionId: String(p.actions[0].action_id ?? ""), value: typeof p.actions[0].value === "string" ? p.actions[0].value : null };
}
