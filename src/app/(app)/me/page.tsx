import type { Metadata } from "next";
import { ComingSoon } from "@/features/coming-soon";

export const metadata: Metadata = { title: "Me" };

export default function Page() {
  return <ComingSoon title="Me" description="Your profile, documents and everything about you." milestone="M1" />;
}
