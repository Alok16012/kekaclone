import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_TENANT, tenantFromHost } from "@/lib/tenancy";

/**
 * Tenant from the subdomain: acme.erp.app (prod) or acme.localhost:3100 (dev); or the one fixed workspace when
 * ERP_DEFAULT_TENANT is set (see src/lib/tenancy.ts). Passed to the app as a request header.
 * Apex domain = marketing + signup only (there is no apex in single-tenant mode).
 */
export function proxy(req: NextRequest) {
  const sub = tenantFromHost(req.headers.get("host"));
  const headers = new Headers(req.headers);
  headers.delete("x-erp-tenant");
  if (sub) headers.set("x-erp-tenant", sub);

  const path = req.nextUrl.pathname;
  if (sub && path === "/") return NextResponse.redirect(new URL("/home", req.url));
  if (sub && path === "/signup") return NextResponse.redirect(new URL("/login", req.url));   // sign-up lives on the apex only
  // optimistic gate: no session cookie on a tenant's app page → straight to sign-in (the page still verifies the session)
  const isPublic = path === "/login" || path === "/forgot-password" || path.startsWith("/auth/") || path.startsWith("/api/") || path.startsWith("/_next")
    || path.startsWith("/verify/id/")   // ID-card QR check: tenant from the subdomain, signed token, minimal answer
    || path === "/offline" || path === "/manifest.webmanifest" || path === "/sw.js" || path.startsWith("/icons/") || path.startsWith("/brand/")
    || path.startsWith("/iclock/")   // ZKTeco / eSSL ADMS push: device identified by its registered serial, tenant from the subdomain
    || path.startsWith("/join/")   // joiner portal: token checked inside the subdomain's company
    || path === "/careers" || path.startsWith("/careers/") || path.startsWith("/p/")   // hiring: public careers page and candidate / interviewer token links
    || path.startsWith("/sign/")   // erp Sign: signer token links (tenant from the subdomain, token checked inside)
    || path === "/brand/background"
    || path === "/developers"   // plat2: API / OAuth2 / webhooks guide (no tenant data)
    || ((process.env.NODE_ENV !== "production" || process.env.ERP_DEMO === "1") && path.startsWith("/dev/"));   // dev mailbox / sms: also on the hosted demo
  if (sub && !isPublic && !req.cookies.has(process.env.SESSION_COOKIE ?? "erp_session")) {
    const url = new URL("/login", req.url);
    if (path !== "/home") url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  // the apex has no app pages: send people to sign up
  if (!sub && !DEFAULT_TENANT && !["/", "/signup", "/design"].some((p) => path === p) && !path.startsWith("/_next") && !path.startsWith("/api") && !((process.env.NODE_ENV !== "production" || process.env.ERP_DEMO === "1") && path.startsWith("/dev/"))) {
    return NextResponse.redirect(new URL("/signup", req.url));
  }
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
