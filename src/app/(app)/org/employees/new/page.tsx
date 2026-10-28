import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { orgOptions } from "@/server/modules/employees/service";
import { assertCan } from "@/server/auth/session";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { AddEmployeeForm } from "@/features/add-employee-form";

export const metadata: Metadata = { title: "Add employee" };

export default async function NewEmployeePage() {
  const o = await load(async (tx, actor) => { assertCan(actor, "employees.write"); return orgOptions(tx); });
  return (
    <div className="mx-auto max-w-(--size-form-max)">
      <PageHeader title="Add employee" breadcrumb="People" description="They get leave balances and the default shift right away." />
      <AddEmployeeForm departments={o.departments} designations={o.designations} locations={o.locations} people={o.people} today={todayIn()} />
    </div>
  );
}
