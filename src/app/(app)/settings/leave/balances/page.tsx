import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { balanceTable } from "@/server/modules/leave/admin";
import { hasAnyLeaveAdmin, isLeaveAdmin } from "@/server/modules/leave/access";
import { BalancesAdmin } from "@/features/leave-admin/balances-ui";
import { NoAccess } from "@/features/leave-admin/route-error";

export const metadata: Metadata = { title: "Leave balances" };

export default async function LeaveBalancesPage(props: PageProps<"/settings/leave/balances">) {
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 80) : "";
  const d = await load(async (tx, actor) => {
    if (!hasAnyLeaveAdmin(actor)) return null;
    return { ...(await balanceTable(tx, actor, q)), canRunAccrual: isLeaveAdmin(actor) };
  });
  if (!d) return <NoAccess what="leave balances" />;
  return <BalancesAdmin rows={d.rows} types={d.types} q={q} canRunAccrual={d.canRunAccrual} />;
}
