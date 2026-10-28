import { NextResponse, type NextRequest } from "next/server";
import { createSession, resolveTenant } from "@/server/auth/session";
import { consumeHandoff } from "@/server/modules/auth/service";

export async function GET(req: NextRequest) {
  const tenant = await resolveTenant(req.headers.get("x-erp-tenant"));
  const token = req.nextUrl.searchParams.get("t");
  const userId = tenant && token ? await consumeHandoff(tenant.id, token) : null;
  if (!tenant || !userId) return NextResponse.redirect(new URL("/login", req.url));
  await createSession(tenant.id, userId);
  return NextResponse.redirect(new URL("/home?welcome=1", req.url));
}
