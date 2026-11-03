"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BadgeCheck, Download, FilePen, FileSpreadsheet, LayoutGrid, List, Mail, MapPin, Search, SlidersHorizontal, UserPlus, Users, X } from "lucide-react";
import { Badge } from "@/ui/badge";
import { toast } from "@/ui/toast";
import { inviteAction } from "@/app/(app)/actions";
import { DataTable, type Column } from "@/ui/table";
import { Avatar } from "@/ui/avatar";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Menu } from "@/ui/overlay";
import { Segmented } from "@/ui/choice";
import { EmptyState } from "@/ui/feedback";
import { download } from "./org-chart";

export type DirRow = { id: string; display_name: string; employee_number: string; work_email: string; designation: string | null; department: string | null; location: string | null; manager: string | null; status: string; joining_date: string; login: string };
type Opt = { id: string; name: string };

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const STATUS: Record<string, { label: string; tone: "success" | "warning" | "neutral" | "accent" }> = {
  active: { label: "Active", tone: "success" }, notice: { label: "Serving notice", tone: "warning" }, relieved: { label: "Exited", tone: "neutral" }, preboarding: { label: "Joining soon", tone: "accent" },
};

/**
 * People directory: filters live in the URL (shareable, survive reloads), search filters in place, table or cards.
 * Exports use the same filters.
 */
export function PeopleDirectory({ rows, options, canAdd, canExport, canSeeExited, view }: {
  rows: DirRow[]; options: { departments: Opt[]; locations: Opt[]; designations: Opt[] }; canAdd: boolean; canExport: boolean; canSeeExited: boolean; view: "table" | "cards";
}) {
  const router = useRouter(), path = usePathname(), sp = useSearchParams();
  const [q, setQ] = React.useState(sp.get("q") ?? "");
  const [showFilters, setShowFilters] = React.useState(false);
  const setParam = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp.toString());
    if (v) n.set(k, v); else n.delete(k);
    router.replace(`${path}?${n.toString()}`, { scroll: false });
  };
  const active = ["department", "location", "designation", "status", "from", "to"].filter((k) => sp.get(k));
  const term = q.trim().toLowerCase();
  const shown = term ? rows.filter((r) => `${r.display_name} ${r.employee_number} ${r.work_email} ${r.designation ?? ""} ${r.department ?? ""}`.toLowerCase().includes(term)) : rows;
  const exportHref = (format: "csv" | "xlsx") => { const n = new URLSearchParams(sp.toString()); n.delete("view"); n.set("format", format); if (q) n.set("q", q); return `/org/employees/export?${n.toString()}`; };
  const sel = (k: string, xs: Opt[], label: string) => (
    <Field label={label}><Select value={sp.get(k) ?? "__all"} onValueChange={(v) => setParam(k, v === "__all" ? null : v)} options={[{ value: "__all", label: `All` }, ...xs.map((x) => ({ value: x.id, label: x.name }))]} size="sm" /></Field>
  );

  const cols: Column<DirRow>[] = [
    { key: "name", header: "Name", sortValue: (r) => r.display_name, cell: (r) => (
      <span className="flex min-w-0 items-center gap-3"><Avatar name={r.display_name} size="sm" /><span className="min-w-0"><Link href={`/people/${r.id}`} onClick={(e) => e.stopPropagation()} className="block truncate font-medium hover:underline">{r.display_name}</Link><span className="block truncate text-sm text-text-muted">{r.work_email}</span></span></span>
    ) },
    { key: "no", header: "Number", sortValue: (r) => r.employee_number, cell: (r) => <span className="tabular">{r.employee_number}</span>, hideBelow: "md" },
    { key: "title", header: "Designation", sortValue: (r) => r.designation ?? "", cell: (r) => r.designation ?? <span className="text-text-muted">—</span> },
    { key: "dept", header: "Department", sortValue: (r) => r.department ?? "", cell: (r) => r.department ?? <span className="text-text-muted">—</span>, hideBelow: "md" },
    { key: "loc", header: "Location", sortValue: (r) => r.location ?? "", cell: (r) => r.location ?? <span className="text-text-muted">—</span>, hideBelow: "lg" },
    { key: "mgr", header: "Reports to", cell: (r) => r.manager ?? <span className="text-text-muted">—</span>, hideBelow: "lg" },
    { key: "status", header: "Status", sortValue: (r) => r.status, cell: (r) => <Badge tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Badge>, hideBelow: "md" },
    ...(canAdd ? [{ key: "login", header: "Sign-in", sortValue: (r: DirRow) => r.login, cell: (r: DirRow) => r.login === "active" ? <Badge tone="success">Active</Badge> : r.login === "invited" ? <Badge tone="accent">Invited</Badge> : r.login === "disabled" ? <Badge tone="danger">Disabled</Badge> : <Badge>Not invited</Badge>, hideBelow: "lg" as const }] : []),
    { key: "doj", header: "Joined", sortValue: (r) => r.joining_date, cell: (r) => fmt(r.joining_date), hideBelow: "lg" },
  ];
  const empty = term || active.length
    ? <EmptyState compact icon={<Search />} title="No one matches" description="Try another name, or clear some filters." action={active.length ? <Button variant="secondary" size="sm" onClick={() => router.replace(path)}>Clear filters</Button> : undefined} />
    : <EmptyState icon={<Users />} title="No one here yet" description="Add the people in your company to get started." action={canAdd ? <Button asChild><Link href="/org/employees/new"><UserPlus />Add employee</Link></Button> : undefined} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 sm:max-w-sm"><Input aria-label="Search people" leading={<Search />} placeholder="Search name, email, number or title" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}><SlidersHorizontal />Filters{active.length ? ` · ${active.length}` : ""}</Button>
          <Segmented label="Layout" value={view} onChange={(v) => setParam("view", v === "cards" ? "cards" : null)}
            options={[{ value: "table" as const, label: <span className="inline-flex items-center gap-1"><List className="size-4" aria-hidden />List</span> }, { value: "cards" as const, label: <span className="inline-flex items-center gap-1"><LayoutGrid className="size-4" aria-hidden />Cards</span> }]} />
          {canExport && <Menu trigger={<Button variant="secondary" size="sm"><Download />Export</Button>} items={[{ label: "CSV", onSelect: () => download(exportHref("csv")) }, { label: "Excel (.xlsx)", onSelect: () => download(exportHref("xlsx")) }]} />}
        </div>
      </div>
      {showFilters && (
        <Card className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
          {sel("department", options.departments, "Department")}
          {sel("location", options.locations, "Location")}
          {sel("designation", options.designations, "Designation")}
          <Field label="Status"><Select size="sm" value={sp.get("status") ?? "current"} onValueChange={(v) => setParam("status", v === "current" ? null : v)}
            options={[{ value: "current", label: "Current" }, { value: "active", label: "Active" }, { value: "notice", label: "Serving notice" }, ...(canSeeExited ? [{ value: "relieved", label: "Exited" }, { value: "all", label: "Everyone" }] : [])]} /></Field>
          <Field label="Joined from"><Input inputSize="sm" type="date" value={sp.get("from") ?? ""} onChange={(e) => setParam("from", e.target.value || null)} /></Field>
          <Field label="Joined to"><Input inputSize="sm" type="date" value={sp.get("to") ?? ""} onChange={(e) => setParam("to", e.target.value || null)} /></Field>
          {active.length > 0 && <div className="sm:col-span-3 lg:col-span-6"><Button variant="ghost" size="sm" onClick={() => router.replace(view === "cards" ? `${path}?view=cards` : path)}><X />Clear filters</Button></div>}
        </Card>
      )}
      <p className="text-sm text-text-muted" aria-live="polite">{shown.length} {shown.length === 1 ? "person" : "people"}</p>
      {view === "cards" ? (
        shown.length === 0 ? <Card>{empty}</Card> : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shown.map((r) => (
              <li key={r.id}>
                <Link href={`/people/${r.id}`} className="flex h-full flex-col items-center gap-2 rounded-lg border border-border bg-surface p-5 text-center shadow-card transition-colors hover:bg-surface-hover">
                  <Avatar name={r.display_name} size="lg" />
                  <span className="min-w-0 max-w-full"><span className="block truncate text-base font-semibold">{r.display_name}</span><span className="block truncate text-sm text-text-muted">{r.designation ?? "No designation"}</span></span>
                  <span className="flex flex-wrap justify-center gap-1.5">{r.department && <Badge>{r.department}</Badge>}{r.status !== "active" && <Badge tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Badge>}</span>
                  <span className="mt-auto flex flex-col gap-0.5 text-sm text-text-muted">
                    <span className="inline-flex items-center justify-center gap-1 truncate"><Mail className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{r.work_email}</span></span>
                    {r.location && <span className="inline-flex items-center justify-center gap-1"><MapPin className="size-3.5" aria-hidden />{r.location}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : (
        <DataTable caption="People in your company" rows={shown} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/people/${r.id}`)}
          selectable={canAdd}
          bulkActions={(ids, clear) => (
            <Button size="sm" onClick={async () => {
              const r = await inviteAction(ids);
              if (!r.ok) { toast.error(r.error); return; }
              const { sent, skipped } = r.data!;
              if (sent) toast.success(`${sent} ${sent === 1 ? "invite" : "invites"} sent`, { description: skipped.length ? `${skipped.length} skipped: ${skipped.slice(0, 3).map((x) => `${x.name} (${x.reason})`).join(", ")}${skipped.length > 3 ? "…" : ""}` : undefined });
              else toast("No invites sent", { description: skipped.slice(0, 3).map((x) => `${x.name} ${x.reason}`).join(", ") });
              clear();
            }}><Mail />Send invites</Button>
          )}
          empty={empty} />
      )}
    </div>
  );
}

/** Bulk tools for HR: import new people, update existing ones from Excel, probation. */
export function BulkMenu() {
  const router = useRouter();
  return (
    <Menu trigger={<Button variant="secondary"><FileSpreadsheet />Bulk</Button>} items={[
      { label: "Import new people", icon: <FileSpreadsheet />, onSelect: () => router.push("/org/employees/import") },
      { label: "Update existing people", icon: <FilePen />, onSelect: () => router.push("/org/employees/update") },
      { label: "Probation", icon: <BadgeCheck />, onSelect: () => router.push("/org/probation") },
    ]} />
  );
}
