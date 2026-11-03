import { describe, expect, it } from "vitest";
import { decodePageCursor, encodePageCursor, endpointUrlProblem, nextRetryMinutes, pageLimit, parseToken, rateLimitTick, signWebhook, verifyWebhookSignature } from "./rules";

describe("api keys and webhooks", () => {
  it("parses only well-formed tokens", () => {
    expect(parseToken("erp_live_abcd1234_" + "x".repeat(40))?.prefix).toBe("abcd1234");
    expect(parseToken("erp_live_abcd1234_short")).toBeNull();
    expect(parseToken("Bearer nope")).toBeNull();
  });
  it("signs and verifies webhook bodies with a time window", () => {
    const sig = signWebhook("whsec_1", '{"a":1}', 1_700_000_000);
    expect(verifyWebhookSignature("whsec_1", '{"a":1}', sig, 1_700_000_010)).toBe(true);
    expect(verifyWebhookSignature("whsec_1", '{"a":2}', sig, 1_700_000_010)).toBe(false);
    expect(verifyWebhookSignature("whsec_2", '{"a":1}', sig, 1_700_000_010)).toBe(false);
    expect(verifyWebhookSignature("whsec_1", '{"a":1}', sig, 1_700_001_000)).toBe(false);   // too old
  });
  it("backs off and gives up after six attempts", () => {
    expect(nextRetryMinutes(1)).toBe(1);
    expect(nextRetryMinutes(2)).toBe(5);
    expect(nextRetryMinutes(5)).toBe(720);
    expect(nextRetryMinutes(6)).toBeNull();
  });
  it("refuses private and non-https endpoints", () => {
    expect(endpointUrlProblem("http://example.com/hook")).toMatch(/https/);
    expect(endpointUrlProblem("https://10.0.0.5/hook")).toMatch(/private/);
    expect(endpointUrlProblem("https://acme.localhost:3100/x")).toMatch(/private/);
    expect(endpointUrlProblem("https://acme.erp.app/x", "erp.app")).toMatch(/erp/);
    expect(endpointUrlProblem("https://hooks.example.com/erp")).toBeNull();
    expect(endpointUrlProblem("garbage")).toMatch(/full URL/);
  });
  it("rate limits per minute window", () => {
    let s: ReturnType<typeof rateLimitTick>["state"] | undefined;
    let last!: ReturnType<typeof rateLimitTick>;
    for (let i = 0; i < 121; i++) { last = rateLimitTick(s, 60_000 * 10 + i); s = last.state; }
    expect(last.allowed).toBe(false);
    expect(rateLimitTick(s, 60_000 * 11).allowed).toBe(true);
  });
  it("pages with opaque cursors and bounded limits", () => {
    expect(decodePageCursor(encodePageCursor(150))).toBe(150);
    expect(decodePageCursor("zzz")).toBe(0);
    expect(pageLimit("500")).toBe(100);
    expect(pageLimit("x")).toBe(50);
  });
});
