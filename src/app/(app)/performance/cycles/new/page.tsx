import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { isPerfAdmin, peopleOptions } from "@/server/modules/performance/access";
import { listCycles, listForms } from "@/server/modules/performance/reviews";
import { AdminHeader } from "@/features/performance/admin-header";
import { CycleWizard } from "@/features/performance/cycle-wizard";
import { NoAccess } from "@/features/performance/no-access";
import { todayIn } from "@/lib/dates";

export const metadata: Metadata = { title: "New review cycle" };

export default async function NewCyclePage() {
  const d = await load(async (tx, actor) => {
    if (!isPerfAdmin(actor)) return null;
    const [forms, people, departments, locations, cycles] = await Promise.all([
      listForms(tx), peopleOptions(tx), tx<{ id: string; name: string }[]>`select id, name from departments order by name`, tx<{ id: string; name: string }[]>`select id, name from locations order by name`, listCycles(tx, actor),
    ]);
    return { forms: forms.map((f) => ({ id: f.id, name: f.name, sections: f.sections })), people, departments, locations, sources: cycles.filter((c) => c.kind !== "aggregate" && c.status !== "draft").map((c) => ({ id: c.id, name: c.name })) };
  });
  if (!d) return <><AdminHeader title="New review cycle" admin={false} /><NoAccess what="Creating review cycles" /></>;
  return (
    <>
      <AdminHeader title="New review cycle" admin />
      <CycleWizard {...d} today={todayIn()} />
    </>
  );
}
