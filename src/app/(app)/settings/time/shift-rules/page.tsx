import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import { canAssignSomeone, canManagePolicies, listShifts } from "@/server/modules/attendance/policies";
import { listShiftRules } from "@/server/modules/attendance/roster";
import { ShiftRulesSettings } from "@/features/attendance/settings/shift-rules-ui";
import { NoAccess } from "../no-access";

export const metadata: Metadata = { title: "Shift change rules" };

export default async function ShiftRulesPage() {
  const d = await load(async (tx, actor) => canAssignSomeone(actor)
    ? { rows: await listShiftRules(tx), shifts: (await listShifts(tx, todayIn())).map((s) => ({ id: s.id, name: s.name, code: s.code })), canEdit: canManagePolicies(actor) }
    : null);
  return d ? <ShiftRulesSettings rows={d.rows} shifts={d.shifts} canEdit={d.canEdit} /> : <NoAccess />;
}
