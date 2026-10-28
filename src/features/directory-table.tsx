"use client";
import * as React from "react";
import Link from "next/link";
import { Search, UserPlus, Users } from "lucide-react";
import { DataTable, type Column } from "@/ui/table";
import { Avatar } from "@/ui/avatar";
import { Input } from "@/ui/field";
import { Button } from "@/ui/button";
import { EmptyState } from "@/ui/feedback";
import type { DirectoryRow } from "@/server/modules/employees/service";

export function DirectoryTable({ rows, canAdd }: { rows: DirectoryRow[]; canAdd: boolean }) {
  const [q, setQ] = React.useState("");
  const shown = q ? rows.filter((r) => `${r.display_name} ${r.employee_number} ${r.work_email} ${r.designation ?? ""} ${r.department ?? ""}`.toLowerCase().includes(q.toLowerCase())) : rows;
  const cols: Column<DirectoryRow>[] = [
    { key: "name", header: "Name", sortValue: (r) => r.display_name, cell: (r) => (
      <span className="flex min-w-0 items-center gap-3"><Avatar name={r.display_name} size="sm" /><span className="min-w-0"><span className="block truncate font-medium">{r.display_name}</span><span className="block truncate text-sm text-text-muted">{r.work_email}</span></span></span>
    ) },
    { key: "no", header: "Number", sortValue: (r) => r.employee_number, cell: (r) => <span className="tabular">{r.employee_number}</span>, hideBelow: "md" },
    { key: "title", header: "Designation", sortValue: (r) => r.designation ?? "", cell: (r) => r.designation ?? <span className="text-text-muted">—</span> },
    { key: "dept", header: "Department", sortValue: (r) => r.department ?? "", cell: (r) => r.department ?? <span className="text-text-muted">—</span>, hideBelow: "md" },
    { key: "mgr", header: "Reports to", cell: (r) => r.manager ?? <span className="text-text-muted">—</span>, hideBelow: "lg" },
    { key: "doj", header: "Joined", sortValue: (r) => r.joining_date, cell: (r) => new Date(r.joining_date + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }), hideBelow: "lg" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-sm"><Input aria-label="Search people" leading={<Search />} placeholder="Search name, email, number or title" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <DataTable caption="People in your company" rows={shown} columns={cols} rowKey={(r) => r.id}
        empty={q ? <EmptyState compact icon={<Search />} title={`No one matches “${q}”`} description="Try part of a name or an employee number." />
          : <EmptyState icon={<Users />} title="No one here yet" description="Add the people in your company to get started." action={canAdd ? <Button asChild><Link href="/org/employees/new"><UserPlus />Add employee</Link></Button> : undefined} />} />
    </div>
  );
}
