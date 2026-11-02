import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { orgOptions } from "@/server/modules/employees/service";
import { wizardOptions } from "@/server/modules/corehr/people";
import { hasAnyGrant } from "@/server/modules/corehr/people";
import { AppError } from "@/server/db";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { AddEmployeeWizard } from "@/features/corehr/add-employee-wizard";

export const metadata: Metadata = { title: "Add employee" };

export default async function NewEmployeePage() {
  const o = await load(async (tx, actor) => {
    if (!hasAnyGrant(actor, "employees.write")) throw new AppError("forbidden", "You don't have access to add people.");
    const [base, more] = await Promise.all([orgOptions(tx), wizardOptions(tx, actor)]);
    return { ...base, ...more };
  });
  return (
    <div className="mx-auto max-w-(--size-form-max)">
      <PageHeader title="Add employee" breadcrumb="People" description="Four short steps. They get leave balances, a shift and their policies straight away." />
      <AddEmployeeWizard o={o} today={todayIn()} />
    </div>
  );
}
