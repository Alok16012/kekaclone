import { NextResponse, type NextRequest } from "next/server";

const ROOT = process.env.ROOT_DOMAIN ?? "localhost:3100";

/**
 * Tenant from the subdomain: acme.erp.app (prod) or acme.localhost:3100 (dev).
 * Passed to the app as a request header. Apex domain = marketing + signup only.
 */
export function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const sub = host.endsWith("." + ROOT) ? host.slice(0, -(ROOT.length + 1)) : null;
  const headers = new Headers(req.headers);
  headers.delete("x-erp-tenant");
  if (sub && sub !== "www") headers.set("x-erp-tenant", sub);

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
    || (process.env.NODE_ENV !== "production" && path.startsWith("/dev/"));
  if (sub && !isPublic && !req.cookies.has(process.env.SESSION_COOKIE ?? "erp_session")) {
    const url = new URL("/login", req.url);
    if (path !== "/home") url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  // the apex has no app pages: send people to sign up
  if (!sub && !["/", "/signup", "/design"].some((p) => path === p) && !path.startsWith("/_next") && !path.startsWith("/api") && !(process.env.NODE_ENV !== "production" && path.startsWith("/dev/"))) {
    return NextResponse.redirect(new URL("/signup", req.url));
  }
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
