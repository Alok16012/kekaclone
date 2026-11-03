import { NextResponse, type NextRequest } from "next/server";
import { AppError, withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { beginCalendarConnect, CALENDAR_COOKIE, isCalendarProvider } from "@/server/modules/calendar/service";

/** Step 1 of connecting a personal calendar: remember state + PKCE in a short cookie, send the browser to the provider. */
export async function GET(req: NextRequest, ctx: RouteContext<"/auth/calendar/[provider]/start">) {
  const { provider } = await ctx.params;
  const origin = `${req.headers.get("x-forwarded-proto") ?? "http"}://${req.headers.get("host") ?? new URL(req.url).host}`;
  const back = (msg: string) => NextResponse.redirect(new URL(`/me/connections?calendar_error=${encodeURIComponent(msg)}`, origin));
  const actor = await getActor();
  if (!actor) return NextResponse.redirect(new URL("/login?next=/me/connections", origin));
  if (!isCalendarProvider(provider)) return back("Unknown calendar provider.");
  try {
    const { url, cookie } = await withTenant(actor.tenant.id, (tx) => beginCalendarConnect(tx, actor, provider, new URL(`/auth/calendar/${provider}/callback`, origin).toString()));
    const res = NextResponse.redirect(url);
    res.cookies.set(CALENDAR_COOKIE, Buffer.from(JSON.stringify(cookie), "utf8").toString("base64url"), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/auth/calendar", maxAge: 600 });
    return res;
  } catch (e) {
    return back(e instanceof AppError ? e.message : "We couldn't start the connection. Try again.");
  }
}
