import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { canAssignSomeone, canManagePolicies, listCapture } from "@/server/modules/attendance/policies";
import { CaptureSettings } from "@/features/attendance/settings/capture-ui";
import { NoAccess } from "../no-access";

export const metadata: Metadata = { title: "Clock-in rules" };

export default async function CapturePage() {
  const d = await load(async (tx, actor) => canAssignSomeone(actor) ? { rows: await listCapture(tx), canEdit: canManagePolicies(actor) } : null);
  return d ? <CaptureSettings rows={d.rows} canEdit={d.canEdit} /> : <NoAccess />;
}
