/**
 * Sign-in security rules that don't touch the database: IP allowlists (IPv4 CIDR, exact IPv6) and session lengths.
 * Pure, so they are unit-tested and usable from scripts.
 */

export const SESSION_HOURS_OPTIONS = [
  { value: 8, label: "8 hours (every working day)" },
  { value: 24, label: "1 day" },
  { value: 24 * 7, label: "7 days" },
  { value: 24 * 14, label: "14 days (default)" },
  { value: 24 * 30, label: "30 days" },
] as const;
export const DEFAULT_SESSION_HOURS = 24 * 14;

export function normalizeSessionHours(v: unknown) {
  const n = Number(v);
  return SESSION_HOURS_OPTIONS.some((o) => o.value === n) ? n : DEFAULT_SESSION_HOURS;
}

const ipv4 = (s: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};

/** Parse one allowlist entry: "1.2.3.4", "10.0.0.0/8" or an exact IPv6 address. Returns null when it isn't valid. */
export function parseAllowEntry(raw: string): { kind: "v4"; net: number; bits: number } | { kind: "v6"; addr: string } | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const [ip, bitsRaw] = s.split("/");
  const v4 = ipv4(ip);
  if (v4 !== null) {
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { kind: "v4", net: (v4 & mask) >>> 0, bits };
  }
  if (bitsRaw === undefined && /^[0-9a-f:]+$/.test(ip) && ip.includes(":") && ip.length <= 45) return { kind: "v6", addr: ip };
  return null;
}

/** Entries that don't parse, so the settings form can point at them. */
export function invalidAllowEntries(list: string[]) {
  return list.map((s) => s.trim()).filter((s) => s && parseAllowEntry(s) === null);
}

/**
 * True when the address is inside the allowlist. An empty list allows everyone. An unknown address (no proxy header,
 * e.g. a direct local connection) is allowed too: the list restricts networks, it can't reason about a missing one.
 */
export function ipAllowed(ip: string | null | undefined, list: string[]) {
  const entries = list.map(parseAllowEntry).filter((e): e is NonNullable<typeof e> => e !== null);
  if (entries.length === 0) return true;
  if (!ip) return true;
  const addr = ip.trim().toLowerCase().replace(/^::ffff:/, "");
  const v4 = ipv4(addr);
  return entries.some((e) => {
    if (e.kind === "v4") {
      if (v4 === null) return false;
      const mask = e.bits === 0 ? 0 : (0xffffffff << (32 - e.bits)) >>> 0;
      return ((v4 & mask) >>> 0) === e.net;
    }
    return e.addr === addr;
  });
}

/** Tenant sign-in settings as stored in tenants.auth_settings (all optional; defaults applied here). */
export type AuthSettings = {
  password?: boolean; google?: boolean; microsoft?: boolean; mobile_otp?: boolean; mfa?: "off" | "optional" | "required";
  session_hours?: number; ip_allowlist?: string[]; sso_domains?: string[]; sso_only?: boolean; microsoft_tenant?: string;
};

export function readAuthSettings(raw: unknown): Required<Pick<AuthSettings, "session_hours" | "ip_allowlist" | "sso_domains" | "google" | "microsoft" | "mobile_otp" | "password">> & AuthSettings {
  const a = (raw && typeof raw === "object" ? raw : {}) as AuthSettings;
  return {
    ...a,
    password: a.password !== false,
    google: a.google === true, microsoft: a.microsoft === true, mobile_otp: a.mobile_otp === true,
    session_hours: normalizeSessionHours(a.session_hours),
    ip_allowlist: Array.isArray(a.ip_allowlist) ? a.ip_allowlist.filter((x) => typeof x === "string") : [],
    sso_domains: Array.isArray(a.sso_domains) ? a.sso_domains.filter((x) => typeof x === "string") : [],
  };
}

/** Email domain restriction for SSO: an empty list allows any domain. */
export function domainAllowed(email: string, domains: string[]) {
  const d = email.toLowerCase().split("@")[1] ?? "";
  const list = domains.map((x) => x.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  return list.length === 0 || list.includes(d);
}
