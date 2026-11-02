/** Signed ID-card QR tokens. Pure (node:crypto only) so it is unit-tested; never import it from client code. */
import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC token for the ID-card QR: binds tenant + employee, so a token from one company never resolves in another. */
export function idCardToken(secret: string, tenantId: string, employeeId: string) {
  const mac = createHmac("sha256", secret).update(`idcard|${tenantId}|${employeeId}`).digest("base64url").slice(0, 22);
  return `${employeeId}.${mac}`;
}
export function verifyIdCardToken(secret: string, tenantId: string, token: string): string | null {
  const [id, mac] = token.split(".");
  if (!id || !mac || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const expected = idCardToken(secret, tenantId, id).split(".")[1];
  const a = Buffer.from(mac), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}
