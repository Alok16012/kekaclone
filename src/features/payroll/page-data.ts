import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { verificationStatus } from "@/server/modules/statutory/service";
import { isPayrollAdmin } from "@/server/modules/payroll/access";
import { fmtDate } from "./labels";

/** Props for <StatutoryBanner>, loaded with the page (one CA sign-off record: the statutory module's). */
export async function bannerProps(tx: Tx, actor: Actor) {
  const s = await verificationStatus(tx);
  return {
    verified: s.verified, stale: s.stale, canRecord: isPayrollAdmin(actor),
    verifiedOn: s.latest ? fmtDate(s.latest.verified_on) : null, caName: s.latest?.verified_by_name ?? null,
  };
}
