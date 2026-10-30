/** Trusted-device cookie format: "<token row id>.<secret>". Pure, so it's unit-tested. */
export const TRUSTED_DEVICE_DAYS = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,100}$/;

export function parseDeviceCookie(v: string | null | undefined): { id: string; secret: string } | null {
  if (!v || v.length > 200) return null;
  const i = v.indexOf(".");
  if (i < 0) return null;
  const id = v.slice(0, i), secret = v.slice(i + 1);
  return UUID.test(id) && SECRET.test(secret) ? { id, secret } : null;
}

export const deviceCookieValue = (id: string, secret: string) => `${id}.${secret}`;
