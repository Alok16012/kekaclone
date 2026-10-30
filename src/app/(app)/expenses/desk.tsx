import type { Actor } from "@/server/auth/session";
import { canSeeReports, EXP_PAYOUT, hasAnywhere } from "@/server/modules/expenses/access";
import { PageHeader } from "@/ui/app-shell";
import { DeskNav } from "@/features/expenses/shared";

export const deskAccess = (actor: Actor) => ({ approvals: true, payouts: hasAnywhere(actor, EXP_PAYOUT), reports: canSeeReports(actor) });

/** Header shared by the expense desk pages (approvals, payouts, reports). */
export function DeskHeader({ show, description }: { show: ReturnType<typeof deskAccess>; description: string }) {
  return (
    <>
      <PageHeader title="Expense desk" description={description} />
      <DeskNav show={show} />
    </>
  );
}
