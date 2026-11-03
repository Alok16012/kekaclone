import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { hasAnyPerf, isPerfAdmin, peopleOptions } from "@/server/modules/performance/access";
import { calibration, cycleForEdit, cycleProgress, listCycles, listForms } from "@/server/modules/performance/reviews";
import { AdminHeader } from "@/features/performance/admin-header";
import { CycleDetail } from "@/features/performance/cycle-detail";
import { NoAccess } from "@/features/performance/no-access";
import { todayIn } from "@/lib/dates";

export const metadata: Metadata = { title: "Review cycle" };

export default async function CyclePage(props: PageProps<"/performance/cycles/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    if (!hasAnyPerf(actor)) return "forbidden" as const;
    const [exists] = await tx`select 1 from review_cycles where id = ${id}`;
    if (!exists) return null;
    const admin = isPerfAdmin(actor);
    const progress = await cycleProgress(tx, actor, id);
    const cal = progress.cycle.status === "draft" || progress.cycle.status === "live" ? null : await calibration(tx, actor, id);
    let wizard = null;
    if (admin && progress.cycle.status === "draft") {
      const c = await cycleForEdit(tx, actor, id);
      const [forms, people, departments, locations, cycles] = await Promise.all([
        listForms(tx), peopleOptions(tx), tx<{ id: string; name: string }[]>`select id, name from departments order by name`, tx<{ id: string; name: string }[]>`select id, name from locations order by name`, listCycles(tx, actor),
      ]);
      wizard = {
        forms: forms.map((f) => ({ id: f.id, name: f.name, sections: f.sections })), people, departments, locations,
        sources: cycles.filter((x) => x.kind !== "aggregate" && x.status !== "draft" && x.id !== id).map((x) => ({ id: x.id, name: x.name })),
        initial: { id: c.id, name: c.name, kind: c.kind, periodStart: c.period_start, periodEnd: c.period_end, timelines: c.timelines, reviewers: c.reviewers, formId: c.form_id,
          employeeFilter: c.employee_filter, autoRule: c.auto_rule, sourceCycleIds: c.source_cycle_ids },
      };
    }
    return { admin, progress, cal, wizard };
  });
  if (d === null) notFound();
  if (d === "forbidden") return <><AdminHeader title="Review cycle" admin={false} /><NoAccess what="Review cycles" /></>;
  return (
    <>
      <AdminHeader title={d.progress.cycle.name} admin={d.admin} />
      <CycleDetail {...d} today={todayIn()} initialTab={typeof sp.tab === "string" ? sp.tab : undefined} />
    </>
  );
}
