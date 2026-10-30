import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { caStatus } from "@/server/modules/payroll/setup";
import { isPayrollAdmin } from "@/server/modules/payroll/access";
import { fmtDate } from "./labels";

/** Props for <StatutoryBanner>, loaded with the page. */
export async function bannerProps(tx: Tx, actor: Actor) {
  const s = await caStatus(tx);
  return { verified: s.current, verifiedOn: s.verification ? fmtDate(s.verification.verifiedOn) : null, caName: s.verification?.caName ?? null, canRecord: isPayrollAdmin(actor) };
}
