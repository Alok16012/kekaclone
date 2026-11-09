/**
 * How a request maps to a workspace.
 *   Multi-tenant (default): the workspace is the subdomain of ROOT_DOMAIN — acme.erp.app, acme.localhost:3100.
 *   Single-tenant (ERP_DEFAULT_TENANT set): every host is that one workspace. Used for demos on hosts without
 *   wildcard subdomains (*.vercel.app) and for self-hosted single-company installs. Sign-up is off in this mode.
 * Pure helpers: no Node / Next imports, so proxy.ts and server code share them.
 */
export const DEFAULT_TENANT = process.env.ERP_DEFAULT_TENANT?.trim().toLowerCase() || null;
export const ROOT_DOMAIN = process.env.ROOT_DOMAIN || process.env.VERCEL_PROJECT_PRODUCTION_URL || "localhost:3100";

/** Workspace subdomain for a request host, or null for the apex / an unknown host. */
export function tenantFromHost(host: string | null | undefined): string | null {
  if (DEFAULT_TENANT) return DEFAULT_TENANT;
  const h = (host ?? "").toLowerCase();
  const sub = h.endsWith("." + ROOT_DOMAIN) ? h.slice(0, -(ROOT_DOMAIN.length + 1)) : null;
  return sub && sub !== "www" ? sub : null;
}

/** The host a workspace is served on (no scheme). */
export function tenantHost(subdomain: string): string {
  return DEFAULT_TENANT ? ROOT_DOMAIN : `${subdomain}.${ROOT_DOMAIN}`;
}

/** Absolute URL into a workspace, for emails, hand-offs and QR codes. */
export function tenantUrl(subdomain: string, path: string, proto?: string): string {
  const scheme = proto ?? (ROOT_DOMAIN.startsWith("localhost") ? "http" : "https");
  return `${scheme}://${tenantHost(subdomain)}${path}`;
}
