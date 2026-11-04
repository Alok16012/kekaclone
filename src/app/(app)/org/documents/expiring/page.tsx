import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { load } from "@/server/page-data";
import { expiringDocuments } from "@/server/modules/documents/expiry";
import { PageHeader } from "@/ui/app-shell";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { EmptyState } from "@/ui/feedback";

export const metadata: Metadata = { title: "Expiring documents" };

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const BUCKET = { expired: { label: "Expired", tone: "danger" as const }, week: { label: "Within 7 days", tone: "danger" as const }, month: { label: "Within 30 days", tone: "warning" as const }, later: { label: "Within 90 days", tone: "neutral" as const } };

/** HR: identity documents and uploads that have expired or expire within 90 days, for the people the reader manages. */
export default async function ExpiringPage() {
  const rows = await load((tx, actor) => expiringDocuments(tx, actor));
  const groups = (["expired", "week", "month", "later"] as const).map((b) => ({ b, rows: rows.filter((r) => r.bucket === b) })).filter((g) => g.rows.length);
  return (
    <>
      <PageHeader title="Expiring documents" description="People and HR get a reminder 30 days and 7 days before a document expires. Expired documents stay here until a renewed one is on file." breadcrumb="Documents" />
      <Card>
        <CardHeader title={`${rows.length} ${rows.length === 1 ? "document" : "documents"} to watch`} description="Passports, licences, visas and any upload with an expiry date." />
        {groups.length === 0 ? <EmptyState compact icon={<CalendarClock />} title="Nothing expiring soon" description="Documents with an expiry date in the next 90 days show up here." /> : groups.map((g) => (
          <section key={g.b} className="border-t border-border">
            <h3 className="flex items-center gap-2 px-5 pt-3 text-xs font-medium uppercase tracking-wide text-text-muted">{BUCKET[g.b].label}</h3>
            <ul className="divide-y divide-border">
              {g.rows.map((r) => (
                <li key={`${r.source}:${r.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/people/${r.employee_id}?tab=documents`} className="block truncate text-base font-medium hover:underline">{r.name}</Link>
                    <p className="text-sm text-text-muted">{r.doc_type}{r.department ? ` · ${r.department}` : ""}{r.source === "identity" ? " · identity record" : ""}</p>
                  </div>
                  <Badge tone={BUCKET[r.bucket].tone}>{r.bucket === "expired" ? `Expired ${fmt(r.expiry_date)}` : `Expires ${fmt(r.expiry_date)}`}</Badge>
                  {r.reminded.length > 0 && <span className="text-xs text-text-muted">Reminded at {r.reminded.map((d) => `${d}d`).join(", ")}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Card>
    </>
  );
}
