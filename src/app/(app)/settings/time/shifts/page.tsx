import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import { canAssignSomeone, canManagePolicies, listShifts } from "@/server/modules/attendance/policies";
import { ShiftsSettings } from "@/features/attendance/settings/shifts-ui";
import { NoAccess } from "../no-access";

export const metadata: Metadata = { title: "Shifts" };

export default async function ShiftsPage() {
  const d = await load(async (tx, actor) => canAssignSomeone(actor) ? { rows: await listShifts(tx, todayIn()), canEdit: canManagePolicies(actor) } : null);
  return d ? <ShiftsSettings rows={d.rows} canEdit={d.canEdit} /> : <NoAccess />;
}
