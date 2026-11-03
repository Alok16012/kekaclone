import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signAction, slackApprovalMessage, slackPressedAction, teamsApprovalCard, verifyAction, verifySlackSignature } from "./chat-rules";

describe("chat approval tokens", () => {
  const a = { t: "tenant", s: "step", a: "approver", d: "approved" as const, e: 2_000_000_000 };
  it("round-trips and refuses tampering, wrong secrets and expiry", () => {
    const tok = signAction("secret", a);
    expect(verifyAction("secret", tok, 1_000_000)).toEqual(a);
    expect(verifyAction("other", tok, 1_000_000)).toBeNull();
    expect(verifyAction("secret", tok.slice(0, -2) + "zz", 1_000_000)).toBeNull();
    expect(verifyAction("secret", tok, 2_000_000_001)).toBeNull();
    expect(verifyAction("secret", null, 1)).toBeNull();
    expect(verifyAction("secret", "nope", 1)).toBeNull();
    const declined = signAction("secret", { ...a, d: "rejected" });
    expect(verifyAction("secret", declined, 1)?.d).toBe("rejected");
    expect(declined).not.toBe(tok);
  });
});

describe("slack signature", () => {
  it("accepts a fresh correctly signed request only", () => {
    const body = "payload=%7B%7D", ts = "1700000000";
    const sig = `v0=${createHmac("sha256", "ss").update(`v0:${ts}:${body}`).digest("hex")}`;
    expect(verifySlackSignature("ss", ts, body, sig, 1700000100)).toBe(true);
    expect(verifySlackSignature("ss", ts, body, sig, 1700001000)).toBe(false);   // stale
    expect(verifySlackSignature("ss", ts, body + "x", sig, 1700000100)).toBe(false);
    expect(verifySlackSignature("xx", ts, body, sig, 1700000100)).toBe(false);
    expect(verifySlackSignature("ss", ts, body, null, 1700000100)).toBe(false);
  });
});

describe("messages", () => {
  const m = { summary: "Casual leave · 2 days", requester: "Sneha", approver: "Asha", approveToken: "A", declineToken: "D", actUrl: "https://acme.erp.app/api/chat/act", inboxUrl: "https://acme.erp.app/inbox" };
  it("slack has approve/decline buttons only when tokens exist", () => {
    const withButtons = slackApprovalMessage(m) as { blocks: { type: string; elements?: { action_id: string; value?: string }[] }[] };
    expect(withButtons.blocks[1].elements?.map((e) => e.action_id)).toEqual(["approve", "decline", "open"]);
    expect(withButtons.blocks[1].elements?.[0].value).toBe("A");
    const plain = slackApprovalMessage({ ...m, approveToken: null, declineToken: null }) as { blocks: { elements?: { action_id: string }[] }[] };
    expect(plain.blocks[1].elements?.map((e) => e.action_id)).toEqual(["open"]);
  });
  it("teams card links back to erp with the token in the URL", () => {
    const card = teamsApprovalCard(m) as { attachments: { content: { actions: { title: string; url: string }[] } }[] };
    const acts = card.attachments[0].content.actions;
    expect(acts.map((x) => x.title)).toEqual(["Approve", "Decline", "Open in erp"]);
    expect(acts[0].url).toBe("https://acme.erp.app/api/chat/act?token=A");
    expect((teamsApprovalCard({ ...m, actUrl: null }) as { attachments: { content: { actions: unknown[] } }[] }).attachments[0].content.actions).toHaveLength(1);
  });
  it("reads the pressed button out of a Slack payload", () => {
    expect(slackPressedAction({ type: "block_actions", actions: [{ action_id: "approve", value: "tok" }] })).toEqual({ actionId: "approve", value: "tok" });
    expect(slackPressedAction({ type: "view_submission" })).toBeNull();
  });
});
