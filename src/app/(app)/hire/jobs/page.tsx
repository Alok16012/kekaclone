import type { Metadata } from "next";
import { ComingSoon } from "@/features/coming-soon";

export const metadata: Metadata = { title: "Hiring" };

export default function Page() {
  return <ComingSoon title="Hiring" description="Jobs, candidates, interviews and offers." milestone="M8" />;
}
