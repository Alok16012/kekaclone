import { describe, expect, it } from "vitest";
import { allSigned, canResend, nextSigner, normName, otpProblem, parsePngDataUrl, validateSigners } from "./esign-rules";

describe("erp Sign rules", () => {
  it("validates signers: employees by id, outsiders by email + name, no duplicates", () => {
    expect(validateSigners([]).ok).toBe(false);
    const id = "11111111-1111-1111-1111-111111111111";
    const r = validateSigners([{ employeeId: id, title: "HR Manager" }, { email: "A@x.com", name: "Auditor" }]);
    expect(r.ok && r.signers).toEqual([{ employeeId: id, email: null, name: null, title: "HR Manager" }, { employeeId: null, email: "a@x.com", name: "Auditor", title: null }]);
    expect(validateSigners([{ email: "nope" }]).ok).toBe(false);
    expect(validateSigners([{ employeeId: id }, { employeeId: id }]).ok).toBe(false);
  });
  it("accepts only small real PNG data URLs", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
    expect(parsePngDataUrl("data:image/png;base64," + png.toString("base64"))?.length).toBe(108);
    expect(parsePngDataUrl("data:image/jpeg;base64,AAAA")).toBeNull();
    expect(parsePngDataUrl("data:image/png;base64," + Buffer.alloc(100).toString("base64"))).toBeNull();
    expect(parsePngDataUrl("data:image/png;base64," + Buffer.concat([png, Buffer.alloc(300 * 1024)]).toString("base64"))).toBeNull();
  });
  it("otp checks and resend throttle", () => {
    const now = new Date("2026-11-03T10:00:00Z");
    expect(otpProblem({ otp_hash: null, otp_expires_at: null, otp_attempts: 0 }, now)).toMatch(/Ask for a code/);
    expect(otpProblem({ otp_hash: "x", otp_expires_at: new Date("2026-11-03T09:00:00Z"), otp_attempts: 0 }, now)).toMatch(/expired/);
    expect(otpProblem({ otp_hash: "x", otp_expires_at: new Date("2026-11-03T11:00:00Z"), otp_attempts: 5 }, now)).toMatch(/Too many/);
    expect(otpProblem({ otp_hash: "x", otp_expires_at: new Date("2026-11-03T11:00:00Z"), otp_attempts: 2 }, now)).toBeNull();
    expect(canResend(null, now)).toBe(true);
    expect(canResend(new Date("2026-11-03T09:59:30Z"), now)).toBe(false);
    expect(canResend(new Date("2026-11-03T09:58:00Z"), now)).toBe(true);
  });
  it("picks the next signer in order and knows when everyone has signed", () => {
    const rows = [{ sign_order: 2, status: "waiting" as const }, { sign_order: 1, status: "signed" as const }, { sign_order: 3, status: "waiting" as const }];
    expect(nextSigner(rows)?.sign_order).toBe(2);
    expect(allSigned(rows)).toBe(false);
    expect(allSigned([{ status: "signed" }])).toBe(true);
    expect(allSigned([])).toBe(false);
    expect(normName("  Ánanya  SHARMA. ")).toBe("ananya sharma");
  });
});
