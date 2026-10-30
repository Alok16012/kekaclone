import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { claimDetail, myAdvances, myExpenses } from "@/server/modules/expenses/service";
import { policyFor } from "@/server/modules/expenses/admin";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { ClaimView } from "@/features/expenses/claim-view";
import { ClaimBody } from "@/features/expenses/shared";
import { Card, CardBody } from "@/ui/card";

export const metadata: Metadata = { title: "Expense claim" };

export default async function ClaimPage(props: PageProps<"/me/expenses/claims/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    const detail = await claimDetail(tx, actor, id);
    if (!detail) return null;
    const own = detail.employee.id === actor.employeeId;
    if (!own) return { detail, own };
    const [policy, mine, advances] = await Promise.all([policyFor(tx, actor.employeeId), myExpenses(tx, actor), myAdvances(tx, actor)]);
    return { detail, own, categories: policy?.categories ?? [], unclaimed: mine.unclaimed, advances };
  });
  if (!d) notFound();
  const c = d.detail.claim;
  return (
    <>
      <PageHeader title={`#${c.number} · ${c.title}`} breadcrumb={<Link href="/me/expenses" className="hover:underline">Expenses</Link>}
        description={d.own ? undefined : `${d.detail.employee.name}'s claim`} />
      {d.own && "categories" in d
        ? <ClaimView d={d.detail} categories={d.categories!} unclaimed={d.unclaimed!} advances={d.advances!} today={todayIn()} />
        : <Card><CardBody><ClaimBody d={d.detail} /></CardBody></Card>}
    </>
  );
}
