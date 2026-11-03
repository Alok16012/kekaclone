import { NextResponse, type NextRequest } from "next/server";
import { AppError, withTenant } from "@/server/db";
import { getActor } from "@/server/auth/session";
import { CALENDAR_COOKIE, finishCalendarConnect, isCalendarProvider, syncCalendars, type CalendarCookie } from "@/server/modules/calendar/service";

/** Step 2: check state, exchange the code, store the tokens for the signed-in person, push anything already queued. */
export async function GET(req: NextRequest, ctx: RouteContext<"/auth/calendar/[provider]/callback">) {
  const { provider } = await ctx.params;
  const origin = `${req.headers.get("x-forwarded-proto") ?? "http"}://${req.headers.get("host") ?? new URL(req.url).host}`;
  const done = (q: string) => {
    const res = NextResponse.redirect(new URL(`/me/connections?${q}`, origin));
    res.cookies.delete({ name: CALENDAR_COOKIE, path: "/auth/calendar" });
    return res;
  };
  const back = (msg: string) => done(`calendar_error=${encodeURIComponent(msg)}`);
  const actor = await getActor();
  if (!actor) return NextResponse.redirect(new URL("/login?next=/me/connections", origin));
  if (!isCalendarProvider(provider)) return back("Unknown calendar provider.");
  let c: CalendarCookie | null = null;
  try { c = JSON.parse(Buffer.from(req.cookies.get(CALENDAR_COOKIE)?.value ?? "", "base64url").toString("utf8")) as CalendarCookie; } catch { c = null; }
  const q = req.nextUrl.searchParams;
  if (q.get("error")) return back(q.get("error_description") || "The provider cancelled the connection.");
  const code = q.get("code"), state = q.get("state");
  if (!c || c.provider !== provider || !code || !state || state !== c.state) return back("The connection attempt expired or didn't match. Start again.");
  try {
    await withTenant(actor.tenant.id, (tx) => finishCalendarConnect(tx, actor, c!, code, new URL(`/auth/calendar/${provider}/callback`, origin).toString()));
    await syncCalendars(actor.tenant.id).catch(() => {});
    return done("calendar_connected=1");
  } catch (e) {
    if (!(e instanceof AppError)) console.error(e);
    return back(e instanceof AppError ? e.message : "We couldn't finish the connection. Try again.");
  }
}
