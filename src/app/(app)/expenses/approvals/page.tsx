import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { approvalQueue } from "@/server/modules/expenses/service";
import { ApprovalQueue } from "@/features/expenses/review";
import { DeskHeader, deskAccess } from "../desk";

export const metadata: Metadata = { title: "Expense approvals" };

export default async function ExpenseApprovalsPage() {
  const d = await load(async (tx, actor) => ({ items: await approvalQueue(tx, actor), show: deskAccess(actor) }));
  return (
    <>
      <DeskHeader show={d.show} description="Review claims and advances with their receipts and policy flags." />
      <ApprovalQueue items={d.items} />
    </>
  );
}
