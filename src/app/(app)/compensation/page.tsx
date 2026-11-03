import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { isCompAdmin } from "@/server/modules/performance/access";
import { listCompCycles } from "@/server/modules/performance/compensation";
import { listCycles } from "@/server/modules/performance/reviews";
import { hasAnyPerf } from "@/server/modules/performance/access";
import { PageHeader } from "@/ui/app-shell";
import { CompList } from "@/features/performance/comp-list";
import { todayIn } from "@/lib/dates";

export const metadata: Metadata = { title: "Compensation" };

export default async function CompensationPage() {
  const d = await load(async (tx, actor) => {
    const admin = isCompAdmin(actor);
    const cycles = await listCompCycles(tx, actor);
    const reviewCycles = admin ? (hasAnyPerf(actor) ? await listCycles(tx, actor) : await tx<{ id: string; name: string; status: string; kind: string }[]>`select id, name, status, kind from review_cycles order by created_at desc`) : [];
    return { admin, cycles, reviewCycles: reviewCycles.filter((c) => c.kind === "standard" || c.kind === "aggregate").map((c) => ({ id: c.id, name: c.name, status: c.status })) };
  });
  return (
    <>
      <PageHeader title="Compensation" description={d.admin ? "Increment cycles: budget, rating-based guidelines, manager recommendations, approvals and payroll." : "Increment recommendations for your team."} />
      <CompList {...d} today={todayIn()} />
    </>
  );
}
