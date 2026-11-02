import Link from "next/link";
import { ArrowRight, ClipboardList, ExternalLink, House, Link2, MapPin } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Card, CardHeader } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import { hostOf } from "@/server/modules/home/rules";
import type { QuickLink, RemotePerson } from "@/server/modules/home/service";

/** Company quick links (set up in Settings → Quick links). Hidden when there are none. */
export function QuickLinksCard({ links, canEdit }: { links: QuickLink[]; canEdit: boolean }) {
  if (!links.length && !canEdit) return null;
  return (
    <Card>
      <CardHeader title="Quick links" action={canEdit ? <Link href="/settings/quick-links" className="text-sm font-medium text-accent-text hover:underline">Manage</Link> : undefined} />
      {links.length === 0 ? <EmptyState compact icon={<Link2 />} title="No quick links yet" description="Add the sites your team opens every day." /> : (
        <ul className="grid grid-cols-2 gap-2 px-5 pb-5">
          {links.map((l) => (
            <li key={l.id} className="min-w-0">
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="group flex h-full items-center gap-2 rounded-md border border-border px-3 py-2 hover:bg-surface-sunken">
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{l.label}</span><span className="block truncate text-xs text-text-muted">{hostOf(l.url)}</span></span>
                <ExternalLink className="size-3.5 shrink-0 text-text-muted" aria-hidden /><span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Who is working from home or on duty today (approved requests). */
export function RemoteTodayCard({ people }: { people: RemotePerson[] }) {
  return (
    <Card>
      <CardHeader title="Working remotely today" description={`${people.length} ${people.length === 1 ? "person" : "people"}`} />
      {people.length === 0 ? <EmptyState compact icon={<House />} title="Nobody's remote today" /> : (
        <ul className="flex flex-col gap-3 px-5 pb-5">
          {people.slice(0, 8).map((p) => (
            <li key={p.id} className="flex items-center gap-3">
              <Avatar name={p.name} size="sm" status="remote" />
              <span className="min-w-0">
                <Link href={`/people/${p.id}`} className="block truncate text-base font-medium hover:underline">{p.name}</Link>
                <span className="flex items-center gap-1 text-sm text-text-muted">{p.kind === "wfh" ? <House className="size-3.5" aria-hidden /> : <MapPin className="size-3.5" aria-hidden />}
                  {p.kind === "wfh" ? "Working from home" : "On duty"}{p.half ? " · half day" : ""}</span>
              </span>
            </li>
          ))}
          {people.length > 8 && <li className="text-sm text-text-muted">and {people.length - 8} more</li>}
        </ul>
      )}
    </Card>
  );
}

/** Surveys waiting for the person. Hidden when there are none. */
export function SurveysWaiting({ surveys }: { surveys: { id: string; title: string }[] }) {
  if (!surveys.length) return null;
  const one = surveys.length === 1;
  return (
    <Link href={one ? `/me/surveys/${surveys[0].id}` : "/me/surveys"} className="group flex items-center gap-4 rounded-lg border border-border bg-surface px-4 py-3 shadow-card hover:bg-surface-sunken">
      <span className="flex size-10 items-center justify-center rounded-pill bg-accent-soft text-accent-text"><ClipboardList className="size-5" aria-hidden /></span>
      <span className="min-w-0 flex-1"><span className="block text-base font-medium">{one ? "A survey is waiting for you" : `${surveys.length} surveys are waiting for you`}</span><span className="block truncate text-sm text-text-muted">{one ? surveys[0].title : "Takes a couple of minutes each"}</span></span>
      <ArrowRight className="size-4 text-text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}
