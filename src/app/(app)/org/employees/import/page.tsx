import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { assertCan } from "@/server/auth/permissions";
import { PageHeader } from "@/ui/app-shell";
import { BulkImport } from "@/features/bulk-import";

export const metadata: Metadata = { title: "Import people" };

export default async function ImportPage() {
  await load(async (_tx, actor) => assertCan(actor, "employees.write"));
  return (
    <div className="mx-auto max-w-(--size-form-max)">
      <PageHeader title="Import people from Excel" breadcrumb="People" description="Add many people at once. Each gets leave balances and the default shift." />
      <BulkImport />
    </div>
  );
}
