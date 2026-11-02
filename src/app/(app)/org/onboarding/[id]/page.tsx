import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { processDetail } from "@/server/modules/onboarding/service";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { ProcessView } from "@/features/onboarding/process-view";

export const metadata: Metadata = { title: "Onboarding" };

export default async function OnboardingProcessPage(props: PageProps<"/org/onboarding/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    const p = await processDetail(tx, actor, id, todayIn());
    if (!p) return null;
    const people = p.can.manage ? await tx<{ id: string; name: string; title: string | null; department: string | null }[]>`
      select e.id, e.display_name as name, d.title, dp.name as department from employees e left join designations d on d.id = e.designation_id
      left join departments dp on dp.id = e.department_id where e.status <> 'relieved' order by e.display_name` : [];
    return { p, people, canList: actor.grants.some((g) => g.permissions.includes("*") || g.permissions.includes("onboarding.manage")) };
  });
  if (!d) notFound();
  return (
    <>
      <PageHeader title={`${d.p.employee.first_name}'s onboarding`} breadcrumb={d.canList ? <Link href="/org/onboarding" className="hover:underline">Onboarding</Link> : <Link href="/me/tasks" className="hover:underline">My tasks</Link>} />
      <ProcessView d={d.p} people={d.people} />
    </>
  );
}
