import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { z } from "zod";
import { load } from "@/server/page-data";
import { listTypes, planDetail } from "@/server/modules/leave/admin";
import { isLeaveAdmin } from "@/server/modules/leave/access";
import { orgOptions } from "@/server/modules/employees/service";
import { PlanEditor } from "@/features/leave-admin/plans-ui";
import { NoAccess } from "@/features/leave-admin/route-error";

export const metadata: Metadata = { title: "Leave plan" };

export default async function LeavePlanPage(props: PageProps<"/settings/leave/plans/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    if (!isLeaveAdmin(actor)) return "forbidden" as const;
    const detail = await planDetail(tx, id);
    if (!detail) return null;
    const [types, opts] = await Promise.all([listTypes(tx), orgOptions(tx)]);
    return { ...detail, types: types.map((t) => ({ id: t.id, name: t.name, kind: t.kind })), people: opts.people };
  });
  if (d === "forbidden") return <NoAccess />;
  if (!d) notFound();
  return (
    <>
      <Link href="/settings/leave/plans" className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted hover:text-text"><ChevronLeft className="size-4" aria-hidden />All leave plans</Link>
      <PlanEditor plan={d.plan} rules={d.rules} members={d.members} types={d.types} people={d.people} />
    </>
  );
}
