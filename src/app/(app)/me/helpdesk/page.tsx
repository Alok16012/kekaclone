import type { Metadata } from "next";
import { ComingSoon } from "@/features/coming-soon";

export const metadata: Metadata = { title: "Helpdesk" };

export default function Page() {
  return <ComingSoon title="Helpdesk" description="Raise a question for HR, IT or finance and track the answer." milestone="M7" />;
}
