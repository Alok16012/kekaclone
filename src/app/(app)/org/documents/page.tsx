import type { Metadata } from "next";
import { ComingSoon } from "@/features/coming-soon";

export const metadata: Metadata = { title: "Documents" };

export default function Page() {
  return <ComingSoon title="Documents" description="Company policies, letters and e-signatures." milestone="M3" />;
}
