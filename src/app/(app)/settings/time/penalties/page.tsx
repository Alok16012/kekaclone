import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canAssignSomeone, canManagePolicies, listPenalties } from "@/server/modules/attendance/policies";
import { PenaltySettings } from "@/features/attendance/settings/penalties-ui";
import { NoAccess } from "../no-access";

export const metadata: Metadata = { title: "Penalties" };

export default async function PenaltiesPage() {
  const d = await load(async (tx, actor) => canAssignSomeone(actor) ? {
    rows: await listPenalties(tx),
    types: await tx<{ id: string; name: string }[]>`select id, name from leave_types order by kind = 'unpaid', name`,
    canEdit: canManagePolicies(actor),
  } : null);
  return d ? <PenaltySettings rows={d.rows} types={d.types} canEdit={d.canEdit} /> : <NoAccess />;
}
