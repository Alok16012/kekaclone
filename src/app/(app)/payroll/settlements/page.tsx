import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, DoorOpen } from "lucide-react";
import { load } from "@/server/page-data";
import { canRunPayroll } from "@/server/modules/payrun/access";
import { fnfList } from "@/server/modules/payrun/fnf";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { EmptyState } from "@/ui/feedback";
import { PayrunNoAccess } from "@/features/payrun/no-access";
import { fmtDate, money } from "@/features/payrun/format";

export const metadata: Metadata = { title: "Final settlements" };

const STATUS: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "warning" }> = {
  none: { label: "Not started", tone: "warning" }, draft: { label: "Draft", tone: "accent" }, approved: { label: "Approved", tone: "accent" }, finalized: { label: "Finalised", tone: "success" },
};

export default async function SettlementsPage() {
  const d = await load(async (tx, actor) => (canRunPayroll(actor) ? { ok: true as const, rows: await fnfList(tx, actor) } : { ok: false as const }));
  if (!d.ok) return <PayrunNoAccess />;
  return (
    <div className="flex flex-col gap-6">
      <Link href="/payroll" className="inline-flex w-fit items-center gap-1.5 text-sm text-text-muted hover:text-text"><ArrowLeft className="size-4" aria-hidden />Payroll</Link>
      <PageHeader title="Final settlements" description="Full and final settlements for people serving notice or who have left." />
      <Card>
        {d.rows.length === 0 ? (
          <EmptyState icon={<DoorOpen />} title="No settlements to do" description="When someone's exit is approved, their final settlement appears here." />
        ) : (
          <ul className="divide-y divide-border">
            {d.rows.map((r) => {
              const st = STATUS[r.fnf_status ?? "none"] ?? STATUS.none;
              return (
                <li key={r.id}>
                  <Link href={`/payroll/settlements/${r.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-surface-hover">
                    <span className="min-w-0 flex-1">
                      <span className="block text-base font-medium">{r.name}{r.self && <span className="ml-2 text-sm text-text-muted">(you)</span>}</span>
                      <span className="block text-sm text-text-muted">{r.number} · {r.status === "exited" ? "left on" : "last day"} {fmtDate(r.last_working_date)}</span>
                    </span>
                    {r.net != null && <span className="text-sm tabular text-text-muted">{money(r.net)} net</span>}
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
