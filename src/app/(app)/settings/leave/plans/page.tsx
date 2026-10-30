import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listPlans } from "@/server/modules/leave/admin";
import { isLeaveAdmin } from "@/server/modules/leave/access";
import { PlanList } from "@/features/leave-admin/plans-ui";
import { NoAccess } from "@/features/leave-admin/route-error";

export const metadata: Metadata = { title: "Leave plans" };

export default async function LeavePlansPage() {
  const d = await load(async (tx, actor) => (isLeaveAdmin(actor) ? { plans: await listPlans(tx) } : null));
  if (!d) return <NoAccess />;
  return <PlanList plans={d.plans} />;
}
