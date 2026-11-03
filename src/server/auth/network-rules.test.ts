import { describe, expect, it } from "vitest";
import { domainAllowed, invalidAllowEntries, ipAllowed, normalizeSessionHours, parseAllowEntry, readAuthSettings } from "./network-rules";

describe("ip allowlist", () => {
  it("matches IPv4 addresses and CIDR ranges, exact IPv6", () => {
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("203.0.113.9", ["203.0.113.9"])).toBe(true);
    expect(ipAllowed("203.0.113.10", ["203.0.113.9"])).toBe(false);
    expect(ipAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(ipAllowed("2001:db8::2", ["2001:db8::1"])).toBe(false);
    expect(ipAllowed("1.2.3.4", ["0.0.0.0/0"])).toBe(true);
  });
  it("allows everyone with an empty list and unknown addresses", () => {
    expect(ipAllowed("1.2.3.4", [])).toBe(true);
    expect(ipAllowed(null, ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("1.2.3.4", ["garbage"])).toBe(true);   // nothing valid = no restriction
  });
  it("flags invalid entries", () => {
    expect(parseAllowEntry("256.1.1.1")).toBeNull();
    expect(parseAllowEntry("10.0.0.0/33")).toBeNull();
    expect(invalidAllowEntries(["10.0.0.0/8", "nope", " ", "1.2.3.4"])).toEqual(["nope"]);
  });
});

describe("auth settings", () => {
  it("normalises session hours and lists", () => {
    expect(normalizeSessionHours("8")).toBe(8);
    expect(normalizeSessionHours(99)).toBe(24 * 14);
    const a = readAuthSettings({ google: true, ip_allowlist: ["10.0.0.0/8", 5], session_hours: 24 });
    expect(a.google).toBe(true); expect(a.microsoft).toBe(false); expect(a.password).toBe(true);
    expect(a.ip_allowlist).toEqual(["10.0.0.0/8"]); expect(a.session_hours).toBe(24);
    expect(readAuthSettings(null).session_hours).toBe(24 * 14);
  });
  it("restricts SSO by email domain only when domains are listed", () => {
    expect(domainAllowed("a@acme.in", [])).toBe(true);
    expect(domainAllowed("a@acme.in", ["@acme.in", "Acme.co"])).toBe(true);
    expect(domainAllowed("a@other.in", ["acme.in"])).toBe(false);
  });
});
