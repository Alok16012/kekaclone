import { actOnChatToken } from "@/server/modules/integrations/chat";
import { slackPressedAction, verifySlackSignature } from "@/server/modules/integrations/chat-rules";

/**
 * Slack interactivity endpoint (one per Slack app, any workspace host): verifies the request with
 * SLACK_SIGNING_SECRET, reads the pressed button's signed token and decides the step as the named approver.
 * Replies by replacing the original message. Returns 404 while the secret isn't configured.
 */
export async function POST(req: Request) {
  const secret = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!secret) return Response.json({ error: "Slack approvals aren't configured." }, { status: 404 });
  const body = await req.text();
  if (!verifySlackSignature(secret, req.headers.get("x-slack-request-timestamp"), body, req.headers.get("x-slack-signature"), Math.floor(Date.now() / 1000))) {
    return Response.json({ error: "Bad signature." }, { status: 401 });
  }
  let payload: unknown;
  try { payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}"); } catch { return Response.json({ error: "Bad payload." }, { status: 400 }); }
  const pressed = slackPressedAction(payload);
  if (!pressed) return new Response(null, { status: 200 });   // url_verification / other interaction types: nothing to do
  if (pressed.actionId === "open") return new Response(null, { status: 200 });
  const user = (payload as { user?: { username?: string; name?: string } }).user;
  const r = await actOnChatToken(pressed.value, `via Slack${user?.username ? ` (${user.username})` : ""}`);
  return Response.json({ replace_original: true, text: r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}` });
}
