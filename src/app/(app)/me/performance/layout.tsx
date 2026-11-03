import { Suspense } from "react";
import { PageHeader } from "@/ui/app-shell";
import { PerfNav } from "@/features/performance/perf-nav";
import { FeatureGate } from "@/features/saas/feature-gate";

export default function PerformanceLayout({ children }: LayoutProps<"/me/performance">) {
  return (
    <>
      <PageHeader title="Performance" description="Goals, feedback, 1:1s and reviews." />
      <Suspense fallback={null}>
        <FeatureGate feature="performance">
          <PerfNav />
          {children}
        </FeatureGate>
      </Suspense>
    </>
  );
}
