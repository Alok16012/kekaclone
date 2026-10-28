import type { Metadata } from "next";
import { ComingSoon } from "@/features/coming-soon";

export const metadata: Metadata = { title: "Performance" };

export default function Page() {
  return <ComingSoon title="Performance" description="Goals, check-ins, feedback and reviews." milestone="M9" />;
}
