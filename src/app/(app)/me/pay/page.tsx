import type { Metadata } from "next";
import { ComingSoon } from "@/features/coming-soon";

export const metadata: Metadata = { title: "My finances" };

export default function Page() {
  return <ComingSoon title="My finances" description="Payslips, salary breakup, tax declarations and loans." milestone="M5" />;
}
