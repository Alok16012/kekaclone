import { actOnChatToken } from "@/server/modules/integrations/chat";
import { verifyAction, type ChatAction } from "@/server/modules/integrations/chat-rules";
import { actionSecret } from "@/server/modules/integrations/chat";
import { getActor } from "@/server/auth/session";

/**
 * Approve / decline from a Teams card (or any chat that can only open links). GET shows a small confirm page so a
 * link preview or an accidental tap never decides anything; POST acts. The token is signed and one-use by nature
 * (the step can only be decided once). The card sits in a shared channel, so the token is not proof of who opened it:
 * both GET and POST need an erp session on this workspace signed in as the approver the token names.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · erp</title>
<style>body{margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#14171c}main{max-width:480px;margin:48px auto;padding:0 16px}.card{background:#fff;border:1px solid #e2e5ea;border-radius:12px;padding:28px}h1{font-size:22px;margin:0 0 8px}p{font-size:15px;line-height:22px;color:#535c68}button,a.btn{display:inline-block;margin-top:16px;margin-right:8px;background:#2f5bea;color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:600;padding:12px 20px;cursor:pointer;text-decoration:none}button.danger{background:#c9303e}a.link{color:#2f5bea}</style></head>
<body><main><div class="card">${body}</div></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex" } });
}

const describe = (a: ChatAction) => (a.d === "approved" ? "approve" : "decline");

/** The signed-in approver for this token, or the page to show instead. */
async function approverFor(a: ChatAction, token: string): Promise<{ employeeId: string } | Response> {
  const actor = await getActor();
  if (!actor || actor.tenant.id !== a.t) return page("Sign in first", `<h1>Sign in to erp first</h1><p>Only the approver named on this request can decide it. Sign in to erp, then open the link from chat again.</p><a class="btn" href="/login?next=${esc(encodeURIComponent(`/api/chat/act?token=${token}`))}">Sign in</a>`);
  if (actor.employeeId !== a.a) return page("Not your request", `<h1>This request isn't waiting for you</h1><p>Only the approver named on it can decide it from this link. You're signed in as ${esc(actor.name)}.</p><a class="link" href="/inbox">Open your Inbox</a>`);
  return { employeeId: actor.employeeId };
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  const a = verifyAction(actionSecret(), token, Math.floor(Date.now() / 1000));
  if (!a) return page("Link expired", `<h1>This link has expired</h1><p>Open your Inbox in erp to decide the request.</p>`);
  const who = await approverFor(a, token!);
  if (who instanceof Response) return who;
  return page("Confirm", `<h1>Confirm: ${describe(a)} this request?</h1><p>You're signed in as the approver named on this request. This can't be undone from chat.</p>
<form method="post"><input type="hidden" name="token" value="${esc(token!)}"><button class="${a.d === "rejected" ? "danger" : ""}" type="submit">${a.d === "approved" ? "Approve" : "Decline"}</button></form>`);
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const token = typeof form?.get("token") === "string" ? (form!.get("token") as string) : null;
  const a = verifyAction(actionSecret(), token, Math.floor(Date.now() / 1000));
  if (!a) return page("Link expired", `<h1>This link has expired</h1><p>Open your Inbox in erp to decide the request.</p>`);
  const who = await approverFor(a, token!);
  if (who instanceof Response) return who;
  const r = await actOnChatToken(token, "via chat approval link", who.employeeId);
  return page(r.ok ? "Done" : "Couldn't act", r.ok ? `<h1>${r.decision === "approved" ? "Approved" : "Declined"}</h1><p>${esc(r.message)}</p>` : `<h1>Couldn't act on this request</h1><p>${esc(r.message)}</p>`);
}
