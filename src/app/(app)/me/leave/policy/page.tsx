import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import { policyFor } from "@/server/modules/leave/policy-doc";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { LeavePolicy } from "@/features/leave-policy";

export const metadata: Metadata = { title: "Leave policy" };

/** The signed-in person's leave policy, generated from their plan. */
export default async function MyLeavePolicyPage() {
  const doc = await load(async (tx, actor) => {
    const [e] = await tx<{ leave_plan_id: string | null }[]>`select leave_plan_id from employees where id = ${actor.employeeId}`;
    return e?.leave_plan_id ? policyFor(tx, e.leave_plan_id, todayIn()) : null;
  });
  return (
    <>
      <PageHeader title="Leave policy" description="What you're entitled to and how requests work, written from the rules of your leave plan." />
      {doc ? <LeavePolicy doc={doc} pdfHref="/me/leave/policy/pdf" backHref="/me/leave" backLabel="Back to leave" />
        : <Card><EmptyState compact title="You're not on a leave plan yet" description="Ask HR to add you to one; the policy for it shows up here." /></Card>}
    </>
  );
}
