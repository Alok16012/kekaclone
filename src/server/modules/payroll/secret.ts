/**
 * Field encryption for sensitive values at rest (bank account numbers): AES-256-GCM with a key from ERP_DATA_KEY
 * (64 hex characters or base64 of 32 bytes). The tenant and employee ids are bound in as associated data, so a
 * ciphertext copied onto another person's row (or tenant) fails to decrypt instead of paying the wrong account.
 *
 * Layout: 1 byte version | 12 byte IV | 16 byte tag | ciphertext.
 * Server-only by use (imported only from server modules); kept free of the "server-only" marker so it can be unit-tested.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = 1;
/** Development fallback so a fresh checkout works; production refuses to start bank features without a real key. */
const DEV_KEY = "erp-local-development-key-do-not-use-in-production";

function key(): Buffer {
  const raw = process.env.ERP_DATA_KEY?.trim();
  if (raw) {
    const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (k.length !== 32) throw new Error("ERP_DATA_KEY must be 32 bytes (64 hex characters or base64).");
    return k;
  }
  if (process.env.NODE_ENV === "production") throw new Error("ERP_DATA_KEY is not set.");
  return createHash("sha256").update(DEV_KEY).digest();
}

const aad = (scope: string[]) => Buffer.from(scope.join("|"), "utf8");

export function encryptField(plain: string, scope: string[]): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(aad(scope));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]);
}

export function decryptField(blob: Uint8Array, scope: string[]): string {
  const b = Buffer.from(blob);
  if (b.length < 29 || b[0] !== VERSION) throw new Error("Unknown encrypted value format.");
  const d = createDecipheriv("aes-256-gcm", key(), b.subarray(1, 13));
  d.setAAD(aad(scope));
  d.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([d.update(b.subarray(29)), d.final()]).toString("utf8");
}
