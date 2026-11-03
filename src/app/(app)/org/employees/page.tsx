import type { Metadata } from "next";
import Link from "next/link";
import { Network, UserPlus } from "lucide-react";
import { load } from "@/server/page-data";
import { directory, filterOptions, filtersFrom, hasAnyGrant } from "@/server/modules/corehr/people";
import { PageHeader } from "@/ui/app-shell";
import { Button } from "@/ui/button";
import { BulkMenu, PeopleDirectory } from "@/features/corehr/people-directory";

export const metadata: Metadata = { title: "People" };

const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

export default async function EmployeesPage(props: PageProps<"/org/employees">) {
  const sp = await props.searchParams;
  const f = filtersFrom(sp);
  const d = await load(async (tx, actor) => {
    const [rows, options] = await Promise.all([directory(tx, actor, { ...f, q: undefined }), filterOptions(tx)]);
    const canAdd = hasAnyGrant(actor, "employees.write");
    return { rows, options, canAdd, canExport: canAdd || hasAnyGrant(actor, "employees.read") };
  });
  const rows = d.rows.map((r) => ({ id: r.id, display_name: r.display_name, employee_number: r.employee_number, work_email: r.work_email, designation: r.designation, department: r.department, location: r.location, manager: r.manager, status: r.status, joining_date: r.joining_date, login: r.login }));
  return (
    <>
      <PageHeader title="People" description="Everyone in your company. Filter, switch to cards, or export."
        actions={<>
          <Button asChild variant="secondary"><Link href="/org/tree"><Network />Org chart</Link></Button>
          {d.canAdd && <BulkMenu />}
          {d.canAdd && <Button asChild><Link href="/org/employees/new"><UserPlus />Add employee</Link></Button>}
        </>} />
      <PeopleDirectory rows={rows} options={d.options} canAdd={d.canAdd} canExport={d.canExport} canSeeExited={d.canExport} view={one(sp.view) === "cards" ? "cards" : "table"} />
    </>
  );
}
