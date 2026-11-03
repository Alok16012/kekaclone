import { Suspense } from "react";
import { FeatureGate } from "@/features/saas/feature-gate";

/** Hiring is a plan feature: the gate swaps the section for an upgrade notice when the workspace's plan lacks it. */
export default function GatedLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}><FeatureGate feature="hire">{children}</FeatureGate></Suspense>;
}
