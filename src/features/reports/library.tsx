"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, ChartColumn, FileSpreadsheet, MoreHorizontal, Plus, Share2, Trash2, Users } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { ConfirmDialog, Menu } from "@/ui/overlay";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteReportAction } from "@/app/(app)/reports/actions";

export type LibraryItem = { key: string; name: string; description: string; group: string };
export type SavedItem = { id: string; name: string; dataset: string; owner: string | null; mine: boolean; shared_roles: string[]; schedule_text: string | null; next_run_at: string | null; updated_at: string };

/** S182: the standard report library grouped by area, plus your saved and shared custom reports. */
export function ReportLibrary({ library, saved, canBuild }: { library: LibraryItem[]; saved: SavedItem[]; canBuild: boolean }) {
  const router = useRouter();
  const [deleting, setDeleting] = React.useState<SavedItem | null>(null);
  const groups = [...new Set(library.map((r) => r.group))];
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="standard-reports" className="flex flex-col gap-4">
        <h2 id="standard-reports" className="text-md font-semibold">Standard reports</h2>
        {groups.map((g) => (
          <Card key={g}>
            <CardHeader title={g} />
            <ul className="divide-y divide-border border-t border-border">
              {library.filter((r) => r.group === g).map((r) => (
                <li key={r.key}>
                  <Link href={`/reports/${r.key}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-hover">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text" aria-hidden><ChartColumn className="size-4" /></span>
                    <span className="min-w-0 flex-1"><span className="block text-base font-medium">{r.name}</span><span className="block text-sm text-text-muted">{r.description}</span></span>
                    <FileSpreadsheet className="size-4 shrink-0 text-text-muted" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
        <p className="text-sm text-text-muted">Every report only includes the people you may see. Exports are recorded in the audit log.</p>
      </section>
      <section aria-labelledby="saved-reports">
        <div className="mb-3 flex items-center gap-2">
          <h2 id="saved-reports" className="text-md font-semibold">Custom reports</h2>
          {canBuild && <Button asChild size="sm" className="ml-auto"><Link href="/reports/builder"><Plus />New custom report</Link></Button>}
        </div>
        <Card>
          {saved.length === 0 ? (
            <EmptyState compact icon={<Users />} title={canBuild ? "No custom reports yet" : "Nothing shared with you yet"} description={canBuild ? "Pick a dataset, choose columns and filters, save it, share it with roles or schedule it by email." : "Report builders can share their reports with your role."}
              action={canBuild ? <Button asChild variant="secondary"><Link href="/reports/builder">Open the builder</Link></Button> : undefined} />
          ) : (
            <ul className="divide-y divide-border">
              {saved.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-5 py-3">
                  <Link href={`/reports/builder/${s.id}`} className="min-w-0 flex-1 hover:underline">
                    <span className="flex flex-wrap items-center gap-2 text-base font-medium">{s.name}{!s.mine && <Badge tone="accent"><Share2 />Shared by {s.owner ?? "a colleague"}</Badge>}{s.schedule_text && <Badge tone="neutral"><CalendarClock />{s.schedule_text}</Badge>}</span>
                    <span className="block text-sm text-text-muted">{s.dataset.replace(/_/g, " ")}{s.shared_roles.length ? ` · shared with ${s.shared_roles.join(", ")}` : ""}</span>
                  </Link>
                  <Button asChild variant="secondary" size="sm"><a href={`/reports/export?saved=${s.id}&format=xlsx`} download><FileSpreadsheet />XLSX</a></Button>
                  {s.mine && <Menu trigger={<IconButton size="icon-sm" label={`More for ${s.name}`}><MoreHorizontal /></IconButton>} items={[{ label: "Open", onSelect: () => router.push(`/reports/builder/${s.id}`) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(s) }]} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting?.name ?? "report"}?`} description="Its schedule stops too. Files already delivered stay available." confirmLabel="Delete"
        onConfirm={async () => { if (!deleting) return; const r = await deleteReportAction(deleting.id); if (r.ok) toast.success("Report deleted"); else toast.error(r.error); setDeleting(null); }} />
    </div>
  );
}
