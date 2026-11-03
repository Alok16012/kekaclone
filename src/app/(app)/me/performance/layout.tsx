import { PageHeader } from "@/ui/app-shell";
import { PerfNav } from "@/features/performance/perf-nav";

export default function PerformanceLayout({ children }: LayoutProps<"/me/performance">) {
  return (
    <>
      <PageHeader title="Performance" description="Goals, feedback, 1:1s and reviews." />
      <PerfNav />
      {children}
    </>
  );
}
