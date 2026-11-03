import { describe, expect, it } from "vitest";
import { RateLimiter, formatDeviceKey, parseBatch, parseDeviceKey, validateDevice } from "./device-rules";

const id = "0f0f0f0f-1111-4222-8333-444455556666";
const secret = "a".repeat(43);

describe("device keys", () => {
  it("round-trips and rejects malformed keys", () => {
    expect(parseDeviceKey(formatDeviceKey(id, secret))).toEqual({ deviceId: id, secret });
    expect(parseDeviceKey(` ${formatDeviceKey(id, secret)} `)).not.toBeNull();
    expect(parseDeviceKey("dev_not-a-uuid.secretsecretsecretsecretsecretsecret")).toBeNull();
    expect(parseDeviceKey(`dev_${id}.short`)).toBeNull();
    expect(parseDeviceKey(`${id}.${secret}`)).toBeNull();
    expect(parseDeviceKey(null)).toBeNull();
  });
});

describe("punch batches", () => {
  const good = { employee: "EMP0042", at: "2026-11-03T09:31:00+05:30", direction: "in", external_id: "d1-1" };
  it("accepts a valid batch and normalises times to UTC", () => {
    const r = parseBatch({ punches: [good, { ...good, external_id: "d1-2", direction: undefined }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items[0].at).toBe("2026-11-03T04:01:00.000Z");
      expect(r.items[1].direction).toBe("auto");
    }
  });
  it("explains each problem by index", () => {
    const err = (b: unknown) => { const r = parseBatch(b); return r.ok ? null : r.error; };
    expect(err(null)).toMatch(/JSON object/);
    expect(err({ punches: [] })).toMatch(/empty/);
    expect(err({ punches: [{ ...good, employee: "" }] })).toMatch(/punches\[0\].employee/);
    expect(err({ punches: [{ ...good, external_id: "" }] })).toMatch(/external_id/);
    expect(err({ punches: [{ ...good, at: "2026-11-03 09:31" }] })).toMatch(/ISO 8601/);
    expect(err({ punches: [{ ...good, at: "2026-11-03T09:31:00" }] })).toMatch(/ISO 8601/);   // no zone
    expect(err({ punches: [{ ...good, direction: "sideways" }] })).toMatch(/direction/);
    expect(err({ punches: [good, good] })).toMatch(/twice/);
    expect(err({ punches: Array.from({ length: 501 }, (_, i) => ({ ...good, external_id: `x${i}` })) })).toMatch(/at most 500/);
  });
});

describe("rate limiter", () => {
  it("allows a burst up to the rate, then refills over time", () => {
    const l = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect([l.take("d", t0), l.take("d", t0), l.take("d", t0)]).toEqual([true, true, true]);
    expect(l.take("d", t0)).toBe(false);
    expect(l.retryAfter("d")).toBeGreaterThan(0);
    expect(l.take("d", t0 + 20_000)).toBe(true);    // one token back after a third of the window
    expect(l.take("d", t0 + 20_000)).toBe(false);
    expect(l.take("other", t0)).toBe(true);         // keys are independent
  });
});

describe("device validation", () => {
  it("needs a name, a sane serial and a known vendor", () => {
    expect(validateDevice({ name: "Gate", serial: "RG-001", vendor: "zkteco" })).toBeNull();
    expect(validateDevice({ name: "", serial: "RG-001", vendor: "zkteco" })).toMatch(/name/);
    expect(validateDevice({ name: "Gate", serial: "bad serial!", vendor: "zkteco" })).toMatch(/serial/);
    expect(validateDevice({ name: "Gate", serial: "RG-001", vendor: "acme" })).toMatch(/vendor/);
  });
});
