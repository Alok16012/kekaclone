import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { load } from "@/server/page-data";
import { hasAnyPerf, isPerfAdmin } from "@/server/modules/performance/access";
import { listCycles } from "@/server/modules/performance/reviews";
import { AdminHeader } from "@/features/performance/admin-header";
import { CycleList } from "@/features/performance/cycle-list";
import { NoAccess } from "@/features/performance/no-access";
import { Button } from "@/ui/button";

export const metadata: Metadata = { title: "Review cycles" };

export default async function CyclesPage() {
  const d = await load(async (tx, actor) => (hasAnyPerf(actor) ? { cycles: await listCycles(tx, actor), admin: isPerfAdmin(actor) } : null));
  if (!d) return <><AdminHeader title="Review cycles" admin={false} /><NoAccess what="Review cycles" /></>;
  return (
    <>
      <AdminHeader title="Review cycles" description="Set up reviews, follow progress, calibrate and publish ratings." admin
        actions={d.admin ? <Button asChild><Link href="/performance/cycles/new"><Plus />New cycle</Link></Button> : undefined} />
      <CycleList cycles={d.cycles} canCreate={d.admin} />
    </>
  );
}
