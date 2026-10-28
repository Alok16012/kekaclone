import type { Metadata } from "next";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { load } from "@/server/page-data";
import { listEmployees } from "@/server/modules/employees/service";
import { can } from "@/server/auth/session";
import { PageHeader } from "@/ui/app-shell";
import { Button } from "@/ui/button";
import { DirectoryTable } from "@/features/directory-table";

export const metadata: Metadata = { title: "People" };

export default async function EmployeesPage() {
  const d = await load(async (tx, actor) => ({ rows: await listEmployees(tx), canAdd: can(actor, "employees.write") }));
  return (
    <>
      <PageHeader title="People" description={`${d.rows.length} ${d.rows.length === 1 ? "person" : "people"} in your company.`}
        actions={d.canAdd ? <Button asChild><Link href="/org/employees/new"><UserPlus />Add employee</Link></Button> : undefined} />
      <DirectoryTable rows={d.rows} canAdd={d.canAdd} />
    </>
  );
}
