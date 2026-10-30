import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listTypes } from "@/server/modules/leave/admin";
import { isLeaveAdmin } from "@/server/modules/leave/access";
import { LeaveTypes } from "@/features/leave-admin/types-ui";
import { NoAccess } from "@/features/leave-admin/route-error";

export const metadata: Metadata = { title: "Leave types" };

export default async function LeaveTypesPage() {
  const d = await load(async (tx, actor) => (isLeaveAdmin(actor) ? { rows: await listTypes(tx) } : null));
  if (!d) return <NoAccess />;
  return <LeaveTypes rows={d.rows} />;
}
