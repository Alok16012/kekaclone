import { timingSafeEqual } from "node:crypto";
import postgres from "postgres";
import { pooled } from "@/server/db";
import { runDaily } from "@/server/modules/corehr/daily";

export const maxDuration = 300;

/**
 * Hosted scheduler: Vercel Cron (vercel.json) calls this once a night with `Authorization: Bearer $CRON_SECRET`.
 * Same runner as `pnpm jobs:daily`; `?date=YYYY-MM-DD` catches up a missed day, `?tenant=acme&force=1` re-runs one.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, prepare: !pooled(process.env.DATABASE_ADMIN_URL), onnotice: () => {} });
  try {
    const r = await runDaily(admin, {
      date: url.searchParams.get("date") ?? undefined,
      tenant: url.searchParams.get("tenant") ?? undefined,
      force: url.searchParams.get("force") === "1",
      only: url.searchParams.get("only")?.split(",").filter(Boolean),
    });
    return Response.json(r, { status: r.failed ? 500 : 200 });
  } catch (e) {
    console.error("cron daily", e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    await admin.end();
  }
}
