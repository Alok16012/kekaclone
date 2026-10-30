import { describe, expect, it } from "vitest";
import { deviceCookieValue, parseDeviceCookie } from "./device-rules";

describe("trusted device cookie", () => {
  const id = "0b0f4c4e-8a64-4c2c-9f7a-1f7c3d0e6a11", secret = "a".repeat(43);
  it("round-trips", () => expect(parseDeviceCookie(deviceCookieValue(id, secret))).toEqual({ id, secret }));
  it("rejects malformed values", () => {
    for (const v of [undefined, "", "nodot", `${id}.`, `not-a-uuid.${secret}`, `${id}.short`, `${id}.${secret}$`, `${id}.${"a".repeat(300)}`]) expect(parseDeviceCookie(v)).toBeNull();
  });
});
