import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { idCard } from "@/server/modules/corehr/people";
import { PageHeader } from "@/ui/app-shell";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { PrintButton } from "@/features/corehr/print-button";

export const metadata: Metadata = { title: "ID card" };

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Digital ID card: the QR opens a public page that confirms the person currently works here (and nothing else). */
export default async function IdCardPage(props: PageProps<"/people/[id]/id-card">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const c = await load((tx, actor) => idCard(tx, actor, id));
  if (!c) notFound();
  return (
    <>
      <PageHeader title="ID card" breadcrumb={c.display_name} description="Show it on your phone or print it. Scanning the code confirms you work here." actions={<PrintButton />} />
      <div className="flex justify-center print:block">
        <article aria-label={`ID card for ${c.display_name}`} className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-surface shadow-card print:shadow-none">
          <header className="bg-accent px-5 py-4 text-on-accent">
            <p className="text-xs font-medium uppercase tracking-wide opacity-90">Employee ID</p>
            <p className="truncate text-lg font-semibold">{c.company}</p>
          </header>
          <div className="flex flex-col items-center gap-3 px-5 pb-5 pt-6 text-center">
            <Avatar name={c.display_name} size="xl" />
            <div>
              <h2 className="text-xl font-semibold">{c.display_name}</h2>
              <p className="text-base text-text-muted">{c.designation ?? "—"}{c.department ? ` · ${c.department}` : ""}</p>
            </div>
            {c.status !== "active" && <Badge tone="warning">{c.status === "notice" ? "Serving notice" : c.status}</Badge>}
            <dl className="grid w-full grid-cols-2 gap-3 rounded-md bg-surface-sunken p-3 text-left text-sm">
              <div><dt className="text-text-muted">Employee no.</dt><dd className="font-semibold tabular">{c.employee_number}</dd></div>
              <div><dt className="text-text-muted">Joined</dt><dd className="font-semibold">{fmt(c.joining_date)}</dd></div>
              <div><dt className="text-text-muted">Location</dt><dd className="font-semibold">{c.location ?? "—"}</dd></div>
              <div><dt className="text-text-muted">Blood group</dt><dd className="font-semibold">{c.blood_group ?? "—"}</dd></div>
            </dl>
            {/* the SVG is produced on the server by the qrcode library from our own verification URL */}
            <div className="size-40 rounded-md bg-white p-2" role="img" aria-label="QR code that verifies this ID" dangerouslySetInnerHTML={{ __html: c.qrSvg }} />
            <p className="break-all text-xs text-text-muted">{c.verifyUrl}</p>
          </div>
        </article>
      </div>
    </>
  );
}
