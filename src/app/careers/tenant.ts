import "server-only";
import { connection } from "next/server";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";

/** Public pages read data only for the tenant named by the address (subdomain), never from anything the visitor sends. */
export async function publicTenant() {
  await connection();
  const t = await resolveTenant(await currentSubdomain());
  return t && t.status !== "cancelled" && t.status !== "suspended" ? t : null;
}
