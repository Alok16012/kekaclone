import type { Metadata } from "next";
import { ComingSoon } from "@/features/coming-soon";

export const metadata: Metadata = { title: "Expenses" };

export default function Page() {
  return <ComingSoon title="Expenses" description="Claim expenses with receipts and track reimbursements." milestone="M6" />;
}
