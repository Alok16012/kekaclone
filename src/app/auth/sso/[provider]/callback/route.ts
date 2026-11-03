import { NextResponse, type NextRequest } from "next/server";
import { AppError } from "@/server/db";
import { createSession, resolveTenant } from "@/server/auth/session";
import { completeSso, finishSso } from "@/server/modules/auth/oidc";
import { decodeSsoCookie, isSsoProvider, SSO_COOKIE } from "@/server/modules/auth/oidc-rules";
import { ipAllowed } from "@/server/auth/network-rules";

/** Step 2 of SSO: check state, exchange the code, verify the id_token, link to the existing account, sign in. */
export async function GET(req: NextRequest, ctx: RouteContext<"/auth/sso/[provider]/callback">) {
  const { provider } = await ctx.params;
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  const back = (msg: string) => {
    const res = NextResponse.redirect(new URL(`/login?sso_error=${encodeURIComponent(msg)}`, req.url));
    res.cookies.delete({ name: SSO_COOKIE, path: "/auth/sso" });
    return res;
  };
  if (!tenant || !isSsoProvider(provider)) return back("This sign-in method isn't available.");
  const c = decodeSsoCookie(req.cookies.get(SSO_COOKIE)?.value);
  const q = req.nextUrl.searchParams;
  if (q.get("error")) return back(q.get("error_description") || "The provider cancelled the sign-in.");
  const code = q.get("code"), state = q.get("state");
  if (!c || c.provider !== provider || !code || !state || state !== c.state) return back("Your sign-in session expired or didn't match. Start again.");
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if (!ipAllowed(ip, tenant.authSettings?.ip_allowlist ?? [])) return back("Sign-in isn't allowed from this network.");
  try {
    const claims = await finishSso(provider, tenant, { code, redirectUri: new URL(`/auth/sso/${provider}/callback`, req.url).toString(), verifier: c.verifier, nonce: c.nonce });
    const userId = await completeSso(tenant, provider, claims, { ip, userAgent: req.headers.get("user-agent") });
    await createSession(tenant.id, userId);
    const res = NextResponse.redirect(new URL(c.next, req.url));
    res.cookies.delete({ name: SSO_COOKIE, path: "/auth/sso" });
    return res;
  } catch (e) {
    if (!(e instanceof AppError)) console.error(e);
    return back(e instanceof AppError ? e.message : "We couldn't finish the sign-in. Try again.");
  }
}
