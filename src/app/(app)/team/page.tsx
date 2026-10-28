import type { Metadata } from "next";
import { ComingSoon } from "@/features/coming-soon";

export const metadata: Metadata = { title: "My team" };

export default function Page() {
  return <ComingSoon title="My team" description="Your team's attendance, leave calendar and performance." milestone="M2" />;
}
