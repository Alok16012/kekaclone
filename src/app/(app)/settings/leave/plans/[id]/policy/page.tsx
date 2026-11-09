import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import { isLeaveAdmin } from "@/server/modules/leave/access";
import { policyFor } from "@/server/modules/leave/policy-doc";
import { LeavePolicy } from "@/features/leave-policy";
import { NoAccess } from "@/features/leave-admin/route-error";

export const metadata: Metadata = { title: "Leave policy document" };

/** A plan's generated policy document, as employees on the plan see it. */
export default async function PlanPolicyPage(props: PageProps<"/settings/leave/plans/[id]/policy">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => (isLeaveAdmin(actor) ? { doc: await policyFor(tx, id, todayIn()) } : "forbidden" as const));
  if (d === "forbidden") return <NoAccess />;
  if (!d.doc) notFound();
  return <LeavePolicy doc={d.doc} pdfHref={`/settings/leave/plans/${id}/policy/pdf`} backHref={`/settings/leave/plans/${id}`} backLabel="Back to the plan" />;
}
