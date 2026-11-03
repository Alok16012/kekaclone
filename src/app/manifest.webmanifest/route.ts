import type { NextRequest } from "next/server";
import { resolveTenant } from "@/server/auth/session";
import { accentProblem } from "@/server/modules/saas/branding-rules";

/**
 * Web app manifest, per workspace: the company's name and accent colour. Public (installing happens before sign-in);
 * reads only the public tenant lookup.
 */
export async function GET(req: NextRequest) {
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  const accent = tenant?.branding?.accent && !accentProblem(tenant.branding.accent) ? tenant.branding.accent : "#2f5bea";
  const name = tenant ? `${tenant.name} · erp` : "erp";
  const manifest = {
    id: "/home", name, short_name: tenant ? tenant.name.slice(0, 12) : "erp", description: "People, time and payroll in one place.",
    start_url: "/home", scope: "/", display: "standalone", orientation: "portrait", background_color: "#ffffff", theme_color: accent, lang: "en-IN",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Clock in or out", url: "/me/attendance", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Apply for leave", url: "/me/leave?apply=1", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Inbox", url: "/inbox", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
  return Response.json(manifest, { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=300" } });
}
