import { describe, expect, it } from "vitest";
import { decryptField, encryptField } from "./secret";

describe("field encryption (AES-256-GCM)", () => {
  const scope = ["tenant-1", "employee-1"];
  it("round-trips and never stores the plain text", () => {
    const blob = encryptField("123456789012", scope);
    expect(blob.toString("utf8")).not.toContain("123456789012");
    expect(decryptField(blob, scope)).toBe("123456789012");
  });
  it("uses a fresh IV each time", () => {
    expect(encryptField("123456789012", scope).equals(encryptField("123456789012", scope))).toBe(false);
  });
  it("fails for another person or tenant, and when tampered with", () => {
    const blob = encryptField("123456789012", scope);
    expect(() => decryptField(blob, ["tenant-1", "employee-2"])).toThrow();
    expect(() => decryptField(blob, ["tenant-2", "employee-1"])).toThrow();
    const bad = Buffer.from(blob); bad[bad.length - 1] ^= 1;
    expect(() => decryptField(bad, scope)).toThrow();
  });
});
