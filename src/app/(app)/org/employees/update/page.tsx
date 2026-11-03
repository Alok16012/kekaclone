import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { AppError } from "@/server/db";
import { hasAnyGrant } from "@/server/modules/corehr/people";
import { PageHeader } from "@/ui/app-shell";
import { BulkUpdate } from "@/features/corehr/bulk-update";

export const metadata: Metadata = { title: "Update people from Excel" };

export default async function UpdatePage() {
  await load(async (_tx, actor) => { if (!hasAnyGrant(actor, "employees.write")) throw new AppError("forbidden", "You don't have access to update people."); });
  return (
    <div className="mx-auto max-w-(--size-form-max)">
      <PageHeader title="Update people from Excel" breadcrumb="People" description="Change many profiles at once: titles, departments, managers, contact details and your own fields." />
      <BulkUpdate />
    </div>
  );
}
