import { slackPressedAction, verifySlackSignature } from "@/server/modules/integrations/chat-rules";

/**
 * Slack interactivity endpoint (one per Slack app, any workspace host): verifies the request with
 * SLACK_SIGNING_SECRET and acknowledges button presses. It never decides anything: the message sits in a shared
 * channel and Slack tells us nothing that ties the presser to an erp approver, so Approve / Decline are link buttons
 * that open erp's confirm page (/api/chat/act), which acts only for the approver's own signed-in session.
 * Returns 404 while the secret isn't configured.
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
  // approve / decline / open are link buttons: the browser opens erp; Slack only needs a 200 here
  return new Response(null, { status: 200 });
}
