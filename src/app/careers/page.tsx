import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { withTenant } from "@/server/db";
import { careersHome } from "@/server/modules/hire/public";
import { jobTypeLabel } from "@/server/modules/hire/rules";
import { Card } from "@/ui/card";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { Html } from "@/features/hire/shared";
import { publicTenant } from "./tenant";

export const metadata: Metadata = { title: "Careers" };

async function Body() {
  const t = await publicTenant();
  if (!t) return <Card><EmptyState title="This careers page doesn't exist" description="Check the address and try again." /></Card>;
  const d = await withTenant(t.id, (tx) => careersHome(tx));
  return (
    <>
      <header className="mb-8">
        <p className="text-sm font-medium text-text-muted">{d.company}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{d.site.title}</h1>
        {d.site.branding?.tagline && <p className="mt-2 text-lg text-text-muted">{d.site.branding.tagline}</p>}
        {d.site.about_html && <Html html={d.site.about_html} className="mt-4 text-text-muted" />}
      </header>
      <h2 className="mb-3 text-lg font-semibold">Open roles ({d.jobs.length})</h2>
      {d.jobs.length === 0 ? <Card><EmptyState title="No openings right now" description="Check back soon." /></Card> : (
        <ul className="flex flex-col gap-3">
          {d.jobs.map((j) => (
            <li key={j.id}>
              <Card className="p-4 transition-colors hover:border-border-strong">
                <Link href={`/careers/${j.id}`} className="text-md font-semibold hover:underline">{j.title}</Link>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-text-muted">
                  {j.location && <span className="inline-flex items-center gap-1"><MapPin aria-hidden className="size-3.5" />{j.location}</span>}
                  {j.department && <span>{j.department}</span>}<span>{jobTypeLabel(j.job_type)}</span>
                  {j.experience_min != null && <span>{j.experience_min}{j.experience_max != null ? `–${j.experience_max}` : "+"} years</span>}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-10 text-center text-xs text-text-muted">Powered by erp</p>
    </>
  );
}

export default function CareersPage() {
  return <Suspense fallback={<div className="flex flex-col gap-4"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}><Body /></Suspense>;
}
