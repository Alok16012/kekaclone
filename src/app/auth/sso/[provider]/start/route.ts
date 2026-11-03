import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@/server/db";
import { resolveTenant } from "@/server/auth/session";
import { beginSso } from "@/server/modules/auth/oidc";
import { encodeSsoCookie, isSsoProvider, SSO_COOKIE } from "@/server/modules/auth/oidc-rules";

/** Step 1 of SSO: remember state/nonce/PKCE in a short cookie and send the browser to the provider. */
export async function GET(req: NextRequest, ctx: RouteContext<"/auth/sso/[provider]/start">) {
  const { provider } = await ctx.params;
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  const back = (msg: string) => NextResponse.redirect(new URL(`/login?sso_error=${encodeURIComponent(msg)}`, req.url));
  if (!tenant || !isSsoProvider(provider)) return back("This sign-in method isn't available.");
  const rawNext = req.nextUrl.searchParams.get("next") ?? "/home";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/home";
  try {
    const { url, cookie } = await beginSso(provider, tenant, new URL(`/auth/sso/${provider}/callback`, req.url).toString(), next);
    const res = NextResponse.redirect(url);
    res.cookies.set(SSO_COOKIE, encodeSsoCookie(cookie), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/auth/sso", maxAge: 600 });
    return res;
  } catch (e) {
    return back(e instanceof AppError ? e.message : "We couldn't start the sign-in. Try again.");
  }
}
