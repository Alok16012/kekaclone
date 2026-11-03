"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, Upload, Users } from "lucide-react";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { DataTable } from "@/ui/table";
import { EmptyState } from "@/ui/feedback";
import { experienceLabel, SOURCES, sourceLabel } from "@/server/modules/hire/rules";
import type { CandidateRow } from "@/server/modules/hire/candidates";
import type { FieldDef } from "@/server/modules/hire/setup";
import { AddCandidateDialog, ImportDialog } from "./add-candidate";
import { day, StageBadge } from "./shared";

/** S143: the candidate database. Search by name, email, phone, company, title or tag; filter by tag and source. */
export function CandidatesDb({ rows, tags, q, tag, source, canAdd, fields }: { rows: CandidateRow[]; tags: { tag: string; n: number }[]; q: string; tag: string; source: string; canAdd: boolean; fields: FieldDef[] }) {
  const router = useRouter();
  const [text, setText] = React.useState(q);
  const [adding, setAdding] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const go = (next: { q?: string; tag?: string; source?: string }) => {
    const p = new URLSearchParams();
    const v = { q: text, tag, source, ...next };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
    router.push(`/hire/candidates${p.size ? `?${p}` : ""}`);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <form role="search" className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); go({ q: text }); }}>
          <Input leading={<Search />} value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, email, phone, company or tag" aria-label="Search candidates" className="lg:w-96" />
          <Button type="submit" variant="secondary">Search</Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Select size="sm" value={source || "all"} onValueChange={(v) => go({ source: v === "all" ? "" : v })} options={[{ value: "all", label: "Any source" }, ...SOURCES.map((s) => ({ value: s.value, label: s.label }))]} className="w-44" />
          {canAdd && <Button size="sm" variant="secondary" onClick={() => setImporting(true)}><Upload />Import</Button>}
          {canAdd && <Button size="sm" onClick={() => setAdding(true)}><Plus />Add candidate</Button>}
        </div>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Filter by tag">
          <span className="text-sm text-text-muted">Tags:</span>
          {tags.slice(0, 20).map((t) => (
            <button key={t.tag} type="button" aria-pressed={tag === t.tag} onClick={() => go({ tag: tag === t.tag ? "" : t.tag })}
              className={`rounded-pill px-2.5 py-0.5 text-sm ${tag === t.tag ? "bg-accent text-on-accent" : "bg-neutral-soft text-neutral-text hover:bg-surface-hover"}`}>{t.tag} <span className="tabular opacity-70">{t.n}</span></button>
          ))}
        </div>
      )}
      <DataTable caption="Candidates" rows={rows} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/hire/candidates/${r.id}`)}
        empty={<EmptyState icon={<Users />} title={q || tag || source ? "No one matches" : "No candidates yet"} description={q || tag || source ? "Try a different search." : canAdd ? "Add candidates, import a sheet, or publish a job to the careers page." : undefined} />}
        columns={[
          { key: "name", header: "Name", sortValue: (r) => r.name.toLowerCase(), cell: (r) => (
            <div className="min-w-0"><Link href={`/hire/candidates/${r.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">{r.name}</Link><p className="truncate text-sm text-text-muted">{r.email}</p></div>
          ) },
          { key: "now", header: "Currently", hideBelow: "md", cell: (r) => <span className="text-sm">{[r.current_title, r.current_company].filter(Boolean).join(" at ") || "—"}<span className="block text-text-muted">{experienceLabel(r.experience_months) ?? ""}</span></span> },
          { key: "jobs", header: "Jobs", cell: (r) => r.applications.length === 0 ? <Badge>Talent pool</Badge> : (
            <div className="flex flex-col gap-1">{r.applications.slice(0, 2).map((a) => <span key={a.job_id} className="flex flex-wrap items-center gap-1.5 text-sm"><span className="truncate">{a.job}</span><StageBadge group={a.status === "hired" ? "hired" : a.group} label={a.status === "active" ? a.stage : undefined} /></span>)}
              {r.applications.length > 2 && <span className="text-xs text-text-muted">+{r.applications.length - 2} more</span>}</div>
          ) },
          { key: "tags", header: "Tags", hideBelow: "lg", cell: (r) => <div className="flex flex-wrap gap-1">{r.tags.slice(0, 4).map((t) => <Badge key={t}>{t}</Badge>)}</div> },
          { key: "source", header: "Source", hideBelow: "lg", cell: (r) => <span className="text-sm">{sourceLabel(r.source)}</span> },
          { key: "added", header: "Added", hideBelow: "md", sortValue: (r) => new Date(r.created_at).getTime(), cell: (r) => <span className="text-sm text-text-muted">{day(r.created_at)}</span> },
        ]} />
      {rows.length >= 500 && <Card className="p-3 text-sm text-text-muted">Showing the 500 most recent. Search to narrow it down.</Card>}
      <AddCandidateDialog open={adding} onClose={() => setAdding(false)} jobId={null} fields={fields} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} jobId={null} />
    </div>
  );
}
