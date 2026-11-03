import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { isPerfAdmin } from "@/server/modules/performance/access";
import { getSettings, listCompetencies, ratingScales } from "@/server/modules/performance/settings";
import { listPeriods } from "@/server/modules/performance/goals";
import { listForms } from "@/server/modules/performance/reviews";
import { AdminHeader } from "@/features/performance/admin-header";
import { PerfSettingsView } from "@/features/performance/settings-view";
import { NoAccess } from "@/features/performance/no-access";

export const metadata: Metadata = { title: "Performance settings" };

export default async function PerfSettingsPage() {
  const d = await load(async (tx, actor) => {
    if (!isPerfAdmin(actor)) return null;
    const [settings, scales, periods, forms, library] = await Promise.all([getSettings(tx), ratingScales(tx), listPeriods(tx), listForms(tx), listCompetencies(tx)]);
    return { settings, scales, periods, forms, library: library.map((c) => ({ id: c.id, kind: c.kind, name: c.name })) };
  });
  if (!d) return <><AdminHeader title="Performance settings" admin={false} /><NoAccess what="Performance settings" /></>;
  return (
    <>
      <AdminHeader title="Performance settings" description="Goal style, rating scale and bands, how ratings combine, goal periods and review forms." admin />
      <PerfSettingsView {...d} />
    </>
  );
}
